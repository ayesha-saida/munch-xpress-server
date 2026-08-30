const { auth } = require('../firebase/firebaseAdmin')

const verifyToken = async (req, res, next) => {
  const header = req.headers.authorization || ''

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized: no token sent' })
  }

  try {
    req.decoded = await auth.verifyIdToken(header.split(' ')[1])
    return next()
  } catch (error) {
    // expired, tampered with, or signed for a different firebase project
    return res.status(401).json({ success: false, message: 'Unauthorized: invalid token' })
  }
}
 
const requireAdmin = (userCollection) => async (req, res, next) => {
  try {
    const account = await userCollection.findOne({ email: req.decoded.email })

    if (account?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: admins only' })
    }

    req.account = account
    return next()
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

const requireSeller = (userCollection, restaurantCollection) => async (req, res, next) => {
  try {
    const account = await userCollection.findOne({ email: req.decoded.email })

    if (account?.role !== 'seller') {
      return res.status(403).json({
        success: false,
        message: account?.role === 'admin'
          ? 'Forbidden: admins do not own a restaurant'
          : 'Forbidden: sellers only',
      })
    }

    const restaurant = await restaurantCollection.findOne({ ownerEmail: account.email })

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: 'No restaurant found for this account',
      })
    }

    req.account = account
    req.restaurant = restaurant

    return next()
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

module.exports = { verifyToken, requireAdmin, requireSeller }
