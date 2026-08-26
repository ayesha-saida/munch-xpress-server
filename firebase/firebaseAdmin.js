const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const encodedKey = process.env.FB_SERVICE_KEY

if (!encodedKey) {
  throw new Error(
    'FB_SERVICE_KEY is missing from .env, so login tokens cannot be '
    + 'verified. See the setup steps at the top of firebase/firebaseAdmin.js'
  )
}

let serviceAccount

try {
  serviceAccount = JSON.parse(Buffer.from(encodedKey, 'base64').toString('utf8'))
} catch (error) {
  throw new Error(
    `FB_SERVICE_KEY is not valid base64 encoded JSON: ${error.message}`
  )
}

initializeApp({
  credential: cert(serviceAccount),
})

module.exports = { auth: getAuth() }
