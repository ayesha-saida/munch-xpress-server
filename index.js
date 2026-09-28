require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT ;

//middlewire
const { verifyToken, requireAdmin, requireSeller } = require("./middlewares/auth");
const { validateSellerRequest } = require("./utils/sellerRequest");
const { validateMenuItem } = require("./utils/menuItem");
const { normalizeQuantity, toMenuItemId, 
        hydrateCart, maxQuantity } = require("./utils/cart");
const payments = require("./utils/payment");       
const { validateCheckout, groupByRestaurant, 
  checkoutTotal, makeOrderNumber, forCustomer } = require("./utils/order");  
const notify = require("./utils/notification"); 


// MongoDB
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: process.env.SITE_DOMAIN,
  })
);

app.get("/", (req, res) => {
  res.send("This is MunchXpress Server!");
});


async function run() {
  try {
   await client.connect();

    const db = client.db('MunchXpress') 
    const userCollection = db.collection('users')
    const sellerRequestCollection = db.collection('sellerRequests')
    const restaurantCollection = db.collection('restaurants') 
    const menuItemCollection = db.collection('menuItems')
    const cartCollection = db.collection('carts')
    const orderCollection = db.collection('orders')
    const notificationCollection = db.collection('notifications')

    
    const adminOnly = requireAdmin(userCollection) 
    const sellerOnly = requireSeller(userCollection, restaurantCollection)

    await Promise.all([
      menuItemCollection.createIndex({ restaurantId: 1 }),
      menuItemCollection.createIndex({ available: 1, createdAt: -1 }),
      cartCollection.createIndex({ email: 1 }, { unique: true }),
    ])

    
    // Users related API's
    app.post('/users', verifyToken, async (req, res) => {
      try {
        const { email, uid } = req.decoded
        const name = (req.body?.name || '').trim()
        const photoURL = (req.body?.photoURL || '').trim()

        const existing = await userCollection.findOne({ email })

        if (existing) {           
          const refreshed = {}
          if (name && name !== existing.name) refreshed.name = name
          if (photoURL && photoURL !== existing.photoURL) refreshed.photoURL = photoURL

          if (Object.keys(refreshed).length) {
            await userCollection.updateOne({ email }, { $set: refreshed })
          }

          return res.send({
            success: true,
            existed: true,
            user: { ...existing, ...refreshed },
          })
        }

        const user = {
          uid,
          email,
          name,
          photoURL,
          role: 'customer',
          createdAt: new Date(),
        }

        const result = await userCollection.insertOne(user)

        res.status(201).json({
          success: true,
          existed: false,
          user: { ...user, _id: result.insertedId },
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })  
    
  
    app.get('/users', verifyToken, adminOnly, async (req, res) => {
      try {
        const { email, role } = req.query

        const query = {}
        if (email) query.email = email
        if (role) query.role = role

        const result = await userCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray()

        res.send(result)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })      
    

    app.get('/users/:email', verifyToken, adminOnly, async (req, res) => {
      try {
        const user = await userCollection.findOne({ email: req.params.email })

        if (!user) {
          return res.status(404).json({ success: false, message: 'User not found' })
        }

        res.send(user)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

  
    // Seller request related API's
    app.post('/seller-requests', verifyToken, async (req, res) => {
      try {
        const { email, uid } = req.decoded

        const account = await userCollection.findOne({ email })

        if (!account) {
          return res.status(404).json({ success: false, message: 'User not found' })
        }

        if (account.role !== 'customer') {
          return res.status(409).json({
            success: false,
            message: `A ${account.role} account cannot apply to become a seller`,
          })
        }

        const pending = await sellerRequestCollection.findOne({ email, status: 'pending' })

        if (pending) {
          return res.status(409).json({
            success: false,
            message: 'Your application is already waiting to be reviewed',
          })
        }

        const { errors, value } = validateSellerRequest(req.body)

        if (errors.length) {
          return res.status(400).json({ success: false, message: errors[0], errors })
        }

        const request = {
          ...value,
          uid,
          email,
          status: 'pending',
          appliedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          note: '',
        }

        const result = await sellerRequestCollection.insertOne(request)

        res.status(201).json({
          success: true,
          request: { ...request, _id: result.insertedId },
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    // returns the caller’s latest seller application
    app.get('/seller-requests/me', verifyToken, async (req, res) => {
      try {
        const request = await sellerRequestCollection.findOne(
          { email: req.decoded.email },
          { sort: { appliedAt: -1 } }
        )

        res.send({ success: true, request: request || null })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

 
    /* seller request Admin APIs */

    // get all seller requests
    app.get('/seller-requests', verifyToken, adminOnly, async (req, res) => {
      try {
        const { status } = req.query
        const allowedStatuses = ['pending', 'approved', 'rejected'] 

        if (status && !allowedStatuses.includes(status)) {
           return res.status(400).json({
             success: false, 
             message: "status must be one of 'pending', 'approved', or 'rejected'",
             }) 
          }
        
        const filter = status ? { status } : {}        
        const result = await sellerRequestCollection
          .find(filter)
          .sort({ appliedAt: -1 })
          .toArray()

        res.send({ success: true, requests: result, })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    // Approve or reject seller request
    app.patch('/seller-requests/:id', verifyToken, adminOnly, async (req, res) => {
      const session = client.startSession()

      try {
        const { id } = req.params
        const { status, note } = req.body || {}

        // Validate request ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ 
            success: false, 
            message: 'Invalid request id' })
        }

        // Validate request status
        if (!['approved', 'rejected'].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "status must be either 'approved' or 'rejected'",
          })
        }

        const requestId = new ObjectId(id) 
        const cleanNote = typeof note === 'string' ? note.trim() : ''

        if (status === 'rejected') {
          const request = await sellerRequestCollection.findOneAndUpdate(
            { _id: requestId, status: 'pending' }, 
            { $set: { 
              status: 'rejected', note: cleanNote, reviewedAt: new Date(),
              reviewedBy: req.decoded.email }
            },
            { returnDocument: 'after', includeResultMetadata: false  })

            if (!request) { 
              return res.status(404).json({
              success: false, 
              message: 'No pending application with that id, it may already be reviewed'
              }) 
            }

            return res.send({ 
              success: true, request
             })
          }

        const result = await session.withTransaction(async (session) => {
          
          // Find the pending request 
          const request = await sellerRequestCollection.findOne( 
            { _id: requestId, status: 'pending' },
            { session } )                                           

          if (!request) {
            const error = new Error(
              'No pending application with that id, it may already be reviewed' )            

              error.statusCode = 404
              throw error
          }

          // Make sure the applicant still exists 
          const account = await userCollection.findOne( 
            { email: request.email },
            { session } )

          if (!account) {
            const error = new Error(
            'Applicant account no longer exists')
            
            error.statusCode = 404
            throw error 
          }         

      // Make sure the applicant is still a customer 
      if (account.role !== 'customer') {
         const error = new Error(
           `This account is already a ${account.role} account and cannot be promoted to seller` )
          
          error.statusCode = 409 
          throw error 
      }

      // Prevent the same seller from owning multiple restaurants.
      const existingRestaurant = await restaurantCollection.findOne( 
       { ownerEmail: request.email }, { session } )  

      if (existingRestaurant) {
         const error = new Error(
         'This seller already owns a restaurant')

          error.statusCode = 409
          throw error
      }  


       /* included status: 'pending' in the filter so that two admins 
        cannot successfully approve the same application.*/
      const reviewedAt = new Date()

      const updatedRequest = await sellerRequestCollection.findOneAndUpdate(
         { _id: requestId, status: 'pending', },
         { $set: { status: 'approved',
           note: cleanNote,
           reviewedAt,
           reviewedBy: req.decoded.email }, 
         },    
         { returnDocument: 'after',
           includeResultMetadata: false,
           session } )

      if (!updatedRequest) {
        const error = new Error(
           'No pending application with that id, it may already be reviewed' ) 

        error.statusCode = 404
        throw error
      }  
        
      // Promote the customer to seller.
      const becameSellerAt = account.becameSellerAt || reviewedAt
      const userUpdate = await userCollection.updateOne( 
          { email: request.email, role: 'customer' }, 
          { $set: { role: 'seller', becameSellerAt }, },
          { session, } )

      if (userUpdate.matchedCount !== 1) {
         const error = new Error(
           'Applicant account could not be promoted to seller' ) 
        
        error.statusCode = 409
        throw error 
      }                    

      // create restaurant 
      const restaurant = {
          requestId: request._id,
          ownerEmail: request.email,
          ownerUid: request.uid,
          name: request.restaurantName,
          phone: request.phone,
          address: request.address,
          cuisine: request.cuisine,
          logoURL: request.logoURL,
          status: 'active',
          createdAt: new Date(),
      }

        const created = await restaurantCollection.insertOne( restaurant, { session } )

      return {
         request: updatedRequest, 
         restaurant: { ...restaurant, _id: created.insertedId }, 
        } })                 

        // Transaction successfully committed
      return res.send({
          success: true,
          request: result.request ,
          restaurant: result.response,
        })
      } catch (err) {
        console.error('Seller request review error:', err)

        return res.status(err.statusCode || 500).json({ 
          success: false,
          message: err.message })
      }
    })  

    
    app.patch('/users/:id/role', verifyToken, adminOnly, async (req, res) => {
      try {
        const { id } = req.params
        const { role } = req.body || {}

        // Validate user ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid user id',
          })
        }

        // Validate role
        const allowedRoles = ['customer', 'seller', 'admin']

        if (!allowedRoles.includes(role)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid role',
          })
        }

        const userId = new ObjectId(id)

        // Find target user
        const account = await userCollection.findOne({ _id: userId })

        if (!account) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          })
        }

        // Optional: prevent an admin from changing their own role
        if (account.email === req.decoded.email) {
          return res.status(403).json({
            success: false,
            message: 'You cannot change your own role',
          })
        }

        const updated = await userCollection.findOneAndUpdate(
          { _id: userId },
          {
            $set: {
              role,
              roleUpdatedAt: new Date(),
              roleUpdatedBy: req.decoded.email,
            },
          },
          {
            returnDocument: 'after',
            includeResultMetadata: false,
          }
        )

        return res.send({
          success: true,
          message: `User role updated to ${role}`,
          user: updated,
        })
      } catch (err) {
        console.error('Role update error:', err)

        return res.status(500).json({
          success: false,
          message: 'Could not update user role',
        })
      }
    })
      

   // Restaurant related API's

    app.get('/restaurants', async (req, res) => {
      try {
        const result = await restaurantCollection
          .find({ status: 'active' })
          .project({ name: 1, cuisine: 1, logoURL: 1 })
          .sort({ name: 1 })
          .toArray()

        res.send({ success: true, restaurants: result })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    app.get('/restaurants/mine', verifyToken, async (req, res) => {
      try {
        const restaurant = await restaurantCollection.findOne({
          ownerEmail: req.decoded.email,
        })

        res.send({ success: true, restaurant: restaurant || null })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    // Menu item related API's

    app.post('/menu-items', verifyToken, sellerOnly, async (req, res) => {
      try {
        const { errors, value } = validateMenuItem(req.body)

        if (errors.length) {
          return res.status(400).json({ success: false, message: errors[0], errors })
        }

        const now = new Date()

        const item = {
          ...value,
          restaurantId: req.restaurant._id,
          restaurantName: req.restaurant.name,
          ownerEmail: req.decoded.email,
          createdAt: now,
          updatedAt: now,
        }

        const result = await menuItemCollection.insertOne(item)

        res.status(201).json({
          success: true,
          item: { ...item, _id: result.insertedId },
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    app.get('/menu-items/mine', verifyToken, sellerOnly, async (req, res) => {
        try {
          const items = await menuItemCollection
            .find({ restaurantId: req.restaurant._id })
            .sort({ createdAt: -1 })
            .toArray()

          res.send({ success: true, items, restaurant: req.restaurant })
        } catch (err) {
          res.status(500).json({ success: false, message: err.message })
        }
    })


    app.patch('/menu-items/:id', verifyToken, sellerOnly, async (req, res) => {
        try {
          const { id } = req.params

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid item id' })
          }

          const { errors, value } = validateMenuItem(req.body, { partial: true })

          if (errors.length) {
            return res.status(400).json({ success: false, message: errors[0], errors })
          }

          const item = await menuItemCollection.findOneAndUpdate(
            { _id: new ObjectId(id), ownerEmail: req.decoded.email },
            { $set: { ...value, updatedAt: new Date() } },
            { returnDocument: 'after', includeResultMetadata: false }
          )

          if (!item) {
            return res.status(404).json({
              success: false,
              message: 'No menu item of yours with that id',
            })
          }

          res.send({ success: true, item })
        } catch (err) {
          res.status(500).json({ success: false, message: err.message })
        }
    })
    

    app.delete('/menu-items/:id', verifyToken, sellerOnly, async (req, res) => {
      try {
        const { id } = req.params

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid item id' })
        }

        const itemId = new ObjectId(id)

        const item = await menuItemCollection.findOneAndDelete(
          { _id: itemId, ownerEmail: req.decoded.email },
          { includeResultMetadata: false }
        )

        if (!item) {
          return res.status(404).json({
            success: false,
            message: 'No menu item of yours with that id',
          })
        }

        res.send({ success: true, item })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })  

    
    app.get('/menu-categories', (req, res) => {
      res.send({ success: true, categories })
    })


    app.get('/menu-items', async (req, res) => {
      try {
        const { restaurantId, category, search, limit } = req.query

        if (restaurantId && !ObjectId.isValid(restaurantId)) {
          return res.status(400).json({ success: false, message: 'Invalid restaurant id' })
        }

        const openRestaurants = await restaurantCollection
          .find({
            status: 'active',
            ...(restaurantId ? { _id: new ObjectId(restaurantId) } : {}),
          })
          .project({ _id: 1 })
          .toArray()

        if (openRestaurants.length === 0) {
          return res.send({ success: true, items: [] })
        }

        const filter = {
          available: true,
          restaurantId: { $in: openRestaurants.map((one) => one._id) },
        }

        if (category) filter.category = category

        if (search) {
          const term = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

          if (term) filter.name = { $regex: term, $options: 'i' }
        }

        const capped = Math.min(Math.max(Number(limit) || 60, 1), 200)

        const items = await menuItemCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(capped)
          .toArray()

        res.send({ success: true, items })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    // Cart related API's
      const sendCart = async (res, email) => {
      const cart = await cartCollection.findOne({ email })

      const { items, subtotal, removed, staleIds } = await hydrateCart(cart, menuItemCollection)

      if (staleIds.length) {
        await cartCollection.updateOne(
          { email },
          {
            $pull: { items: { menuItemId: { $in: staleIds } } },
            $set: { updatedAt: new Date() },
          }
        )
      }

      return res.send({
        success: true,
        items,
        subtotal,
        removed,
        count: items.reduce((sum, item) => sum + item.quantity, 0),
      })
    }

    /* the caller's cart. An account that has never added anything gets an
       empty cart rather than a 404 */
    app.get('/cart', verifyToken, async (req, res) => {
      try {
        await sendCart(res, req.decoded.email)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    /* Add a dish that is already there. */
    app.post('/cart/items', verifyToken, async (req, res) => {
      try {
        const { email, uid } = req.decoded

        const menuItemId = toMenuItemId(req.body?.menuItemId)

        if (!menuItemId) {
          return res.status(400).json({ success: false, message: 'Invalid menu item id' })
        }

        const quantity = normalizeQuantity(req.body?.quantity ?? 1)

        if (quantity === null) {
          return res.status(400).json({
            success: false,
            message: 'Quantity must be a whole number of at least 1',
          })
        }

        const dish = await menuItemCollection.findOne({ _id: menuItemId })

        if (!dish || dish.available === false) {
          return res.status(404).json({
            success: false,
            message: 'That item is not on the menu right now',
          })
        }

        const restaurant = await restaurantCollection.findOne({ _id: dish.restaurantId })

        if (restaurant?.status !== 'active') {
          return res.status(409).json({
            success: false,
            message: 'That restaurant is not taking orders right now',
          })
        }


        for (let attempt = 0; attempt < 2; attempt += 1) {
          const bumped = await cartCollection.updateOne(
            { email, 'items.menuItemId': menuItemId },
            {
              $inc: { 'items.$.quantity': quantity },
              $set: { updatedAt: new Date() },
            }
          )

          if (bumped.matchedCount > 0) break

          try {
            await cartCollection.updateOne(
              { email },
              {
                $push: { items: { menuItemId, quantity, addedAt: new Date() } },
                $set: { uid, updatedAt: new Date() },
                $setOnInsert: { email, createdAt: new Date() },
              },
              { upsert: true }
            )

            break
          } catch (error) {
            if (error?.code !== 11000 || attempt === 1) throw error
          }
        }
       
        await cartCollection.updateOne(
          {
            email,
            items: { $elemMatch: { menuItemId, quantity: { $gt: maxQuantity } } },
          },
          { $set: { 'items.$.quantity': maxQuantity } }
        )

        await sendCart(res, email)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    /* set a line's quantity outright. 0 is a removal rather than a bad request,
       since that is what the stepper sends on its way down from 1 */
    app.patch('/cart/items/:menuItemId', verifyToken, async (req, res) => {
      try {
        const { email } = req.decoded

        const menuItemId = toMenuItemId(req.params.menuItemId)

        if (!menuItemId) {
          return res.status(400).json({ success: false, message: 'Invalid menu item id' })
        }

        if (Number(req.body?.quantity) === 0) {
          await cartCollection.updateOne(
            { email },
            { $pull: { items: { menuItemId } }, $set: { updatedAt: new Date() } }
          )

          return await sendCart(res, email)
        }

        const quantity = normalizeQuantity(req.body?.quantity)

        if (quantity === null) {
          return res.status(400).json({
            success: false,
            message: 'Quantity must be a whole number between 0 and 99',
          })
        }

        const updated = await cartCollection.updateOne(
          { email, 'items.menuItemId': menuItemId },
          { $set: { 'items.$.quantity': quantity, updatedAt: new Date() } }
        )

        if (updated.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'That item is not in your cart',
          })
        }

        await sendCart(res, email)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    app.delete('/cart/items/:menuItemId', verifyToken, async (req, res) => {
      try {
        const { email } = req.decoded

        const menuItemId = toMenuItemId(req.params.menuItemId)

        if (!menuItemId) {
          return res.status(400).json({ success: false, message: 'Invalid menu item id' })
        }

        await cartCollection.updateOne(
          { email },
          { $pull: { items: { menuItemId } }, $set: { updatedAt: new Date() } }
        )

        await sendCart(res, email)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    /* empty the cart but keep the document, so the unique index on email does
       not have to be re-satisfied on the next add */
    app.delete('/cart', verifyToken, async (req, res) => {
      try {
        const { email } = req.decoded

        await cartCollection.updateOne(
          { email },
          { $set: { items: [], updatedAt: new Date() } }
        )

        await sendCart(res, email)
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


     // Payment related API's
    const settleCheckout = async ({ checkoutId, provider, transactionId, amount }) => {
      const session = client.startSession()

      try {
        return await session.withTransaction(async () => {
          const orders = await orderCollection
            .find({ checkoutId }, { session })
            .toArray()

          const payable = orders.filter((order) => order.status === 'awaiting_payment')

          if (payable.length === 0) return { settled: 0 }

          /* the full checkout, not just what is still waiting: this is the
             figure the gateway was asked for when the session started */
          const owed = checkoutTotal(orders)

          if (amount !== null && amount !== undefined
            && Math.abs(amount - owed) > 0.01) {
            const error = new Error(
              `Paid amount ${amount} does not match the ${owed} owed for this checkout`
            )
            error.statusCode = 409
            throw error
          }

          const paidAt = new Date()
          const payment = { provider, transactionId, paidAt, amount: owed }

          await orderCollection.updateMany(
            { checkoutId, status: 'awaiting_payment' },
            { $set: { status: 'placed', paymentStatus: 'paid', payment, updatedAt: paidAt } },
            { session }
          )

          /* the money landed, so the cart that produced it is spent */
          await cartCollection.updateMany(
            { email: { $in: [...new Set(orders.map((order) => order.customerEmail))] } },
            { $set: { items: [], updatedAt: paidAt } },
            { session }
          )

          await notificationCollection.insertMany(
            payable.map((order) => notify.orderPlacedForSeller({
              ...order,
              status: 'placed',
              paymentStatus: 'paid',
            })),
            { session }
          )

          return { settled: payable.length }
        }, session)
      } finally {
        await session.endSession()
      }
    }

    const releaseCheckout = async (checkoutId) => {
      const session = client.startSession()

      try {
        return await session.withTransaction(async () => {
          const orders = await orderCollection
            .find({ checkoutId, status: 'awaiting_payment' }, { session })
            .toArray()

          if (orders.length === 0) return { released: 0 }

          for (const order of orders) {
            await releaseStock(order.items, session)
          }

          await orderCollection.updateMany(
            { checkoutId, status: 'awaiting_payment' },
            {
              $set: { status: 'cancelled', paymentStatus: 'failed', updatedAt: new Date() },
            },
            { session }
          )

          return { released: orders.length }
        }, session)
      } finally {
        await session.endSession()
      }
    }

    const findCheckout = async (checkoutId) => {
      const orders = await orderCollection.find({ checkoutId }).toArray()

      if (orders.length === 0) return null

      return orders
    }    
    

    app.post('/payments/mock/:checkoutId/confirm', verifyToken, async (req, res) => {
      try {
        if (payments.provider !== 'mock') {
          return res.status(404).json({
            success: false,
            message: 'The mock payment page is not enabled',
          })
        }

        const { checkoutId } = req.params
        const outcome = ['success', 'fail', 'cancel'].includes(req.body?.outcome)
          ? req.body.outcome
          : 'fail'

        const orders = await findCheckout(checkoutId)

        if (!orders || !orders.some((order) => order.customerEmail === req.decoded.email)) {
          return res.status(404).json({ success: false, message: 'No checkout with that id' })
        }

        const verdict = await payments.verifyPayment({ checkoutId, outcome })

        if (verdict.paid) {
          const result = await settleCheckout({
            checkoutId,
            provider: 'mock',
            transactionId: verdict.transactionId,
            amount: null,
          })

          return res.send({ success: true, outcome: 'paid', settled: result.settled })
        }

        if (outcome === 'cancel') {
          const result = await releaseCheckout(checkoutId)

          return res.send({ success: true, outcome: 'cancelled', released: result.released })
        }

        /* a failed attempt keeps the checkout alive, so it can be retried */
        res.send({ success: true, outcome: 'failed', settled: 0 })
      } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, message: err.message })
      }
    })

    
    const sslCommerzReturn = async (req, res) => {
      const source = { ...req.query, ...req.body }
      const checkoutId = String(source.tran_id || '')
      const validationId = String(source.val_id || '')
      const asked = String(source.outcome || 'success').toLowerCase()

      const forward = (outcome) => res.redirect(
        `${payments.clientUrl}/checkout/result/${encodeURIComponent(checkoutId)}` +
        `?outcome=${encodeURIComponent(outcome)}`
      )

      try {
        if (payments.provider !== 'sslcommerz') {
          return res.status(404).json({
            success: false,
            message: 'SSLCommerz is not the payment provider in use',
          })
        }

        if (!checkoutId) return res.redirect(`${payments.clientUrl}/`)

        if (validationId) {
          const verdict = await payments.verifyPayment({ checkoutId, validationId })

          if (verdict.paid) {
            try {
              await settleCheckout({
                checkoutId,
                provider: 'sslcommerz',
                transactionId: verdict.transactionId,
                amount: verdict.amount,
              })
            } catch (error) {
              /* an amount that does not match must never read as a success */
              console.error(`Could not settle checkout ${checkoutId}:`, error.message)

              return forward('mismatch')
            }

            return forward('success')
          }

          /* the gateway sent the customer back but its own validator says no
             money arrived, so the checkout stays payable and can be retried */
          if (asked === 'cancel') await releaseCheckout(checkoutId)

          return forward(asked === 'cancel' ? 'cancel' : 'fail')
        }

        if (asked === 'cancel') await releaseCheckout(checkoutId)

        return forward(asked === 'cancel' ? 'cancel' : 'fail')
      } catch (err) {
        console.error('SSLCommerz return error:', err)

        return forward('fail')
      }
    }    

    app.get('/payments/sslcommerz/return', sslCommerzReturn)
    app.post('/payments/sslcommerz/return', sslCommerzReturn)


    const sslCommerzIpn = async (req, res) => {
      try {
        if (payments.provider !== 'sslcommerz') {
          return res.status(404).send('SSLCommerz is not the payment provider in use')
        }

        const source = { ...req.query, ...req.body }
        const checkoutId = String(source.tran_id || '')
        const validationId = String(source.val_id || '')
        const status = String(source.status || '').toLowerCase()

        if (!checkoutId || !validationId) {
          return res.status(400).send('Missing tran_id or val_id')
        }

        const verdict = await payments.verifyPayment({ checkoutId, validationId })

        if (verdict.paid) {
          await settleCheckout({
            checkoutId,
            provider: 'sslcommerz',
            transactionId: verdict.transactionId,
            amount: verdict.amount,
          })
        } else if (status.includes('cancel')) {
          await releaseCheckout(checkoutId)
        }

        /* the gateway only wants to know it was heard; a duplicate IPN hits
           the guarded update inside settleCheckout and changes nothing */
        res.status(200).send('OK')
      } catch (err) {
        console.error('SSLCommerz IPN error:', err)
        res.status(500).send(err.message)
      }
    }

    app.post('/payments/sslcommerz/ipn', sslCommerzIpn)
    app.get('/payments/sslcommerz/ipn', sslCommerzIpn)


    app.get('/payments/:checkoutId', verifyToken, async (req, res) => {
      try {
        const { checkoutId } = req.params

        const orders = await findCheckout(checkoutId)

        if (!orders) {
          return res.status(404).json({ success: false, message: 'No checkout with that id' })
        }

        const { email } = req.decoded
        const account = await userCollection.findOne({ email })

        const isAdmin = account?.role === 'admin'
        const isCustomer = orders.every((order) => order.customerEmail === email)
        const isOwner = orders.some((order) => order.ownerEmail === email)

        if (!isAdmin && !isCustomer && !isOwner) {
          return res.status(404).json({ success: false, message: 'No checkout with that id' })
        }

        const state = orders.every((order) => order.status === 'cancelled')
          ? 'released'
          : orders.some((order) => order.status === 'awaiting_payment')
            ? 'awaiting_payment'
            : 'settled'

        res.send({
          success: true,
          checkoutId,
          provider: payments.provider,
          paymentMethod: orders[0].paymentMethod,
          state,
          total: checkoutTotal(orders),
          orders: isCustomer && !isAdmin ? orders.map(forCustomer) : orders,
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })
    

    app.post('/payments/:checkoutId/initiate', verifyToken, async (req, res) => {
      try {
        const { checkoutId } = req.params

        const orders = await orderCollection
          .find({ checkoutId, status: 'awaiting_payment' })
          .toArray()

        if (orders.length === 0
          || !orders.every((order) => order.customerEmail === req.decoded.email)) {
          return res.status(404).json({
            success: false,
            message: 'No unpaid checkout with that id',
          })
        }

        let gateway

        try {
          gateway = await payments.initiatePayment({
            checkoutId,
            amount: checkoutTotal(orders),
            customer: {
              name: orders[0].delivery.name,
              email: req.decoded.email,
              phone: orders[0].delivery.phone,
              address: orders[0].delivery.address,
            },
            itemCount: orders.reduce((sum, order) => sum + (order.itemCount || 0), 0),
          })
        } catch (error) {
          return res.status(502).json({ success: false, message: error.message })
        }

        res.send({
          success: true,
          redirectUrl: gateway.redirectUrl,
          provider: payments.provider,
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })    

    
    // Orders related APIs
    const reserveStock = async (lines, session) => {
      for (const line of lines) {
        const dish = await menuItemCollection.findOne({ _id: line.menuItemId }, { session })

        if (!dish || dish.available === false) {
          const error = new Error(`${line.name} is not on the menu right now`)
          error.statusCode = 409
          throw error
        }

        if (typeof dish.quantity !== 'number') continue

        if (dish.quantity < line.quantity) {
          const error = new Error(
            dish.quantity === 0
              ? `${line.name} is sold out`
              : `Only ${dish.quantity} left of ${line.name}`
          )
          error.statusCode = 409
          throw error
        }

        const taken = await menuItemCollection.updateOne(
          { _id: dish._id, quantity: { $gte: line.quantity } },
          { $inc: { quantity: -line.quantity } },
          { session }
        )

        if (taken.matchedCount === 0) {
          const error = new Error(`${line.name} just sold out`)
          error.statusCode = 409
          throw error
        }
      }
    }

    const releaseStock = async (lines, session) => {
      for (const line of lines) {
        await menuItemCollection.updateOne(
          { _id: line.menuItemId, quantity: { $type: 'number' } },
          { $inc: { quantity: line.quantity } },
          { session }
        )
      }
    }

    const insertOrder = async (draft, session) => {
      let order = draft

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const result = await orderCollection.insertOne(order, { session })

          return { ...order, _id: result.insertedId }
        } catch (error) {
          if (error?.code !== 11000 || attempt === 4) throw error

          const { _id, ...kept } = order
          order = { ...kept, orderNumber: makeOrderNumber() }
        }
      }

      return null
    }

    const buildOrderFilter = (query = {}) => {
      const { status, paymentStatus } = query
      const filter = {}

      if (status === 'open') {
        filter.status = { $in: openStatuses }
      } else if (status && !orderStatuses.includes(status)) {
        return { error: `status must be one of: ${orderStatuses.join(', ')}` }
      } else if (status) {
        filter.status = status
      }

      if (paymentStatus && !paymentStatuses.includes(paymentStatus)) {
        return { error: `paymentStatus must be one of: ${paymentStatuses.join(', ')}` }
      }

      if (paymentStatus) filter.paymentStatus = paymentStatus

      return { filter }
    }    

    app.post('/orders', verifyToken, async (req, res) => {
      try {
        const { email } = req.decoded

        const { errors, value } = validateCheckout(req.body)

        if (errors.length) {
          return res.status(400).json({ success: false, message: errors[0], errors })
        }

        const cart = await cartCollection.findOne({ email })
        const { items, removed, staleIds } = await hydrateCart(cart, menuItemCollection)

        /* dishes pulled from the menu while this cart was open -- prune the
           lines and say so, rather than quietly ordering something else */
        if (staleIds.length) {
          await cartCollection.updateOne(
            { email },
            {
              $pull: { items: { menuItemId: { $in: staleIds } } },
              $set: { updatedAt: new Date() },
            }
          )
        }

        if (removed.length) {
          return res.status(409).json({
            success: false,
            message: `${removed.join(', ')} ${
              removed.length === 1 ? 'is' : 'are'
            } no longer available, so your cart was updated`,
            removed,
          })
        }

        if (items.length === 0) {
          return res.status(409).json({ success: false, message: 'Your cart is empty' })
        }

        const groups = groupByRestaurant(items)
        const total = checkoutTotal(groups)
        const itemCount = items.reduce((sum, line) => sum + line.quantity, 0)

        const restaurants = await restaurantCollection
          .find({ _id: { $in: groups.map((group) => group.restaurantId) } })
          .toArray()

        const byId = new Map(restaurants.map((one) => [String(one._id), one]))

        for (const group of groups) {
          const restaurant = byId.get(String(group.restaurantId))

          if (!restaurant || restaurant.status !== 'active') {
            return res.status(409).json({
              success: false,
              message: `${group.restaurantName} is not taking orders right now`,
            })
          }
        }

        const checkoutId = new ObjectId().toString()
        const now = new Date()

        const draftFor = (group) => ({
          orderNumber: makeOrderNumber(),
          checkoutId,
          restaurantId: group.restaurantId,
          restaurantName: group.restaurantName,
          ownerEmail: byId.get(String(group.restaurantId)).ownerEmail,
          customerEmail: email,
          items: group.items,
          itemsTotal: group.itemsTotal,
          deliveryFee: group.deliveryFee,
          total: group.total,
          itemCount: group.items.reduce((sum, line) => sum + line.quantity, 0),
          delivery: {
            name: value.name,
            phone: value.phone,
            address: value.address,
            note: value.note,
          },
          paymentMethod: value.paymentMethod,
          paymentStatus: value.paymentMethod === 'online' ? 'pending' : 'unpaid',
          payment: null,
          status: value.paymentMethod === 'online' ? 'awaiting_payment' : 'placed',
          sellerNote: '',
          placedAt: now,
          updatedAt: now,
        })

        let gateway = null

        if (value.paymentMethod === 'online') {
          try {
            gateway = await payments.initiatePayment({
              checkoutId,
              amount: total,
              customer: {
                name: value.name,
                email,
                phone: value.phone,
                address: value.address,
              },
              itemCount,
            })
          } catch (error) {
            return res.status(502).json({ success: false, message: error.message })
          }
        }

        const session = client.startSession()

        let created

        try {
          created = await session.withTransaction(async () => {
            /*
              A checkout somebody walked away from would hold its reservations
              forever, so anything of this customer's still awaiting payment
              after half an hour is given up here. Anything younger is left
              alone -- it may be the tab they are paying in right now.
            */
            const stale = await orderCollection
              .find({
                customerEmail: email,
                status: 'awaiting_payment',
                placedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) },
              }, { session })
              .toArray()

            for (const old of stale) {
              await releaseStock(old.items, session)
            }

            if (stale.length) {
              await orderCollection.updateMany(
                { _id: { $in: stale.map((order) => order._id) } },
                {
                  $set: { status: 'cancelled', paymentStatus: 'failed', updatedAt: new Date() },
                },
                { session }
              )
            }

            const drafts = groups.map(draftFor)

            for (const draft of drafts) {
              await reserveStock(draft.items, session)
            } 

            const orders = []

            for (const draft of drafts) {
              orders.push(await insertOrder(draft, session))
            }

            if (value.paymentMethod === 'cod') {
              await notificationCollection.insertMany(
                orders.map((order) => notify.orderPlacedForSeller(order)),
                { session }
              )

              await cartCollection.updateOne(
                { email },
                { $set: { items: [], updatedAt: new Date() } },
                { session }
              )
            }

            return orders
          }, session)
        } finally {
          await session.endSession()
        }

        res.status(201).json({
          success: true,
          checkoutId,
          total,
          itemCount,
          paymentMethod: value.paymentMethod,
          orders: created.map(forCustomer),
          /* where to send the browser next; empty for cash on delivery */
          redirectUrl: gateway?.redirectUrl || '',
          provider: payments.provider,
        })
      } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, message: err.message })
      }
    })


    /* the customer's own history, newest first, without the seller's email */
    app.get('/orders/mine', verifyToken, async (req, res) => {
      try {
        const { filter, error } = buildOrderFilter(req.query)

        if (error) return res.status(400).json({ success: false, message: error })

        const orders = await orderCollection
          .find({ ...filter, customerEmail: req.decoded.email })
          .sort({ placedAt: -1 })
          .limit(200)
          .toArray()

        res.send({ success: true, orders: orders.map(forCustomer) })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })

    
    app.get('/orders/seller', verifyToken, sellerOnly, async (req, res) => {
      try {
        const { filter, error } = buildOrderFilter(req.query)

        if (error) return res.status(400).json({ success: false, message: error })

        const orders = await orderCollection
          .find({ ...filter, restaurantId: req.restaurant._id })
          .sort({ placedAt: -1 })
          .limit(200)
          .toArray()

        res.send({ success: true, orders })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    /* every order on the platform, admin only */
    app.get('/orders/all', verifyToken, adminOnly, async (req, res) => {
      try {
        const { filter, error } = buildOrderFilter(req.query)

        if (error) return res.status(400).json({ success: false, message: error })

        const orders = await orderCollection
          .find(filter)
          .sort({ placedAt: -1 })
          .limit(500)
          .toArray()

        res.send({ success: true, orders })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    app.get('/orders/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid order id' })
        }

        const order = await orderCollection.findOne({ _id: new ObjectId(id) })

        if (!order) {
          return res.status(404).json({ success: false, message: 'No order with that id' })
        }

        const { email } = req.decoded
        const account = await userCollection.findOne({ email })

        const isAdmin = account?.role === 'admin'
        const isCustomer = order.customerEmail === email
        const isOwner = order.ownerEmail === email

        if (!isAdmin && !isCustomer && !isOwner) {
          return res.status(404).json({ success: false, message: 'No order with that id' })
        }

        res.send({
          success: true,
          order: isCustomer && !isAdmin ? forCustomer(order) : order,
          viewer: isAdmin ? 'admin' : isOwner ? 'seller' : 'customer',
        })
      } catch (err) {
        res.status(500).json({ success: false, message: err.message })
      }
    })


    const statusTransitions = {
      seller: {
        placed: ['accepted', 'rejected'],
        accepted: ['completed'],
      },
      customer: {
        placed: ['cancelled'],
        awaiting_payment: ['cancelled'],
      },
      admin: {
        placed: ['accepted', 'rejected', 'completed', 'cancelled'],
        accepted: ['completed', 'cancelled'],
        awaiting_payment: ['cancelled'],
      },
    }


    app.patch('/orders/:id/status', verifyToken, async (req, res) => {
      try {
        const { id } = req.params

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: 'Invalid order id' })
        }

        const target = typeof req.body?.status === 'string' ? req.body.status.trim() : ''

        if (!['accepted', 'rejected', 'completed', 'cancelled'].includes(target)) {
          return res.status(400).json({
            success: false,
            message: "status must be one of 'accepted', 'rejected', 'completed' or 'cancelled'",
          })
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : ''
        const { email } = req.decoded
        const account = await userCollection.findOne({ email })
        const orderId = new ObjectId(id)

        const session = client.startSession()

        let outcome

        try {
          outcome = await session.withTransaction(async () => {
            const order = await orderCollection.findOne({ _id: orderId }, { session })

            if (!order) {
              const error = new Error('No order with that id')
              error.statusCode = 404
              throw error
            }

            /* the role is read from mongo and matched against the order, so
               the caller never gets to say which side they are on */
            const viewer = account?.role === 'admin'
              ? 'admin'
              : order.customerEmail === email
                ? 'customer'
                : order.ownerEmail === email
                  ? 'seller'
                  : null

            if (!viewer) {
              const error = new Error('No order with that id')
              error.statusCode = 404
              throw error
            }

            const allowed = statusTransitions[viewer][order.status] || []

            if (!allowed.includes(target)) {
              const error = new Error(
                `An order that is ${order.status.replace('_', ' ')} cannot become ` +
                `${target.replace('_', ' ')} for ${viewer === 'admin' ? 'an admin' : `a ${viewer}`}`
              )
              error.statusCode = 409
              throw error
            }

            const now = new Date()
            const set = { status: target, updatedAt: now }

            /* the kitchen's reason, shown to the customer on the order card */
            if (note && viewer !== 'customer') set.sellerNote = note


            if (target === 'completed' && order.paymentMethod === 'cod') {
              set.paymentStatus = 'paid'
            }

            if ((target === 'rejected' || target === 'cancelled')
              && order.paymentStatus === 'paid') {
              set.paymentStatus = 'refund_due'
            }

            /* a checkout that was never paid leaves nothing owed behind */
            if (target === 'cancelled' && order.status === 'awaiting_payment') {
              set.paymentStatus = 'failed'
            }

            const updated = await orderCollection.findOneAndUpdate(
              { _id: orderId, status: order.status },
              { $set: set },
              { returnDocument: 'after', includeResultMetadata: false, session }
            )

            if (target === 'cancelled' || target === 'rejected') {
              await releaseStock(order.items, session)
            }

            const messages = {
              accepted: notify.orderAcceptedForCustomer,
              rejected: notify.orderRejectedForCustomer,
              completed: notify.orderCompletedForCustomer,
            }

            const told = { ...order, ...set }

            if (messages[target]) {
              await notificationCollection.insertOne(messages[target](told), { session })
            } else if (target === 'cancelled' && order.status !== 'awaiting_payment') {
              /* the seller never saw an unpaid checkout, so there is nothing
                 to tell them about it disappearing */
              await notificationCollection.insertOne(
                notify.orderCancelledForSeller(told),
                { session }
              )
            }

            return { order: updated, viewer }
          }, session)
        } finally {
          await session.endSession()
        }

        res.send({
          success: true,
          order: outcome.viewer === 'customer' ? forCustomer(outcome.order) : outcome.order,
        })
      } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, message: err.message })
      }
    })
    

    app.listen(port, () => {
       console.log(`Server is running on port ${port}`)
    })


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  }
    catch (err) {
     console.error("MongoDB connection failed:", err);
    }
  
  /* finally {
    // Ensures that the client will close when you finish/error
    await client.close();
  }  */
}
run().catch(console.dir);
