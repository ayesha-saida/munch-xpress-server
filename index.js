require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

//middlewire
const { verifyToken, requireAdmin} = require("./middlewares/auth");
const { validateSellerRequest } = require("./utils/sellerRequest");

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
    
    const adminOnly = requireAdmin(userCollection) 

    
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
