require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// Firebase

//middlewire
const { verifyToken, requireAdmin } = require("./middlewares/auth");


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
