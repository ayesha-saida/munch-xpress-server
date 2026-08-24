require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// Firebase
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8")
);

initializeApp({
  credential: cert(serviceAccount),
});

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
    origin: ["http://localhost:5173"],
  })
);

app.get("/", (req, res) => {
  res.send("This is MunchXpress Server!");
});


// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}



async function run() {
  try {
   await client.connect();

    const db = client.db('MunchXpress') 
    const userCollection = db.collection('users')


    // Users related API's
   app.post('/users', async(req, res) => {
      try {
          const user = req.body
          user.role = 'customer'
          user.createdAt = new Date()

          const email = user.email
          const userExists = await userCollection.findOne({ email })

           if(userExists) {  // prevent duplicate insertion
              return res.send({ message: 'user exists' })
        }  
            // Insert user
           const result = await userCollection.insertOne(user);
           const createdUser = await userCollection.findOne({ _id: result.insertedId });  

            res.status(201).json({ success: true, user: createdUser })
           }
              catch (err) {
            res.status(500).json({ success: false, message: err.message })
           }        
        })
    
    app.get('/users',  async (req, res) => {  
      const {email} = req.query

      const query = email? { email } : {}
            const cursor = userCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        }); 
    
    app.get('/users/:email', async(req,res) => {
       const { email } = req.params;

       const user = await userCollection.findOne({ email });

         if (!user) {
          return res.status(404).send({ message: 'User not found' });
         }
       res.send(user);
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
