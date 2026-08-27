require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

//middlewire
const { verifyToken, requireAdmin } = require("./middlewares/auth");
const { validateSellerRequest } = require("./utils/sellerRequest");

// MongoDB
const { MongoClient, ServerApiVersion } = require("mongodb");

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
    const adminOnly = requireAdmin(userCollection)  
    const sellerRequestCollection = db.collection('sellerRequests')

    
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
