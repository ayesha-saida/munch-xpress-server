const maxLengths = {
  restaurantName: 100,
  cuisine: 60,
  address: 300,
  tradeLicense: 60,
  logoURL: 500,
}

const clean = (value) => (typeof value === 'string' ? value.trim() : '')

/* same loose rule as the client, digits only counted so +880 / () / - pass */
const isValidPhone = (phone) => {
  if (!/^[\d\s+()-]+$/.test(phone)) return false

  const digits = phone.replace(/\D/g, '')

  return digits.length >= 7 && digits.length <= 15
}

/*
  Returns { errors, value }. errors is an array of readable messages and is
  empty when the application is usable; value holds only the trimmed fields
  the server is willing to store.
*/
const validateSellerRequest = (body = {}) => {
  const value = {
    restaurantName: clean(body.restaurantName),
    phone: clean(body.phone),
    address: clean(body.address),
    cuisine: clean(body.cuisine),
    tradeLicense: clean(body.tradeLicense),
    logoURL: clean(body.logoURL),
  }

  const errors = []

  if (value.restaurantName.length < 2) {
    errors.push('Restaurant name is required')
  }

  if (!value.phone) {
    errors.push('Phone number is required')
  } else if (!isValidPhone(value.phone)) {
    errors.push('Phone number is not a valid number')
  }

  if (value.address.length < 10) {
    errors.push('Please give a full pickup address')
  }

  if (!value.cuisine) {
    errors.push('Cuisine type is required')
  }

  for (const [field, limit] of Object.entries(maxLengths)) {
    if (value[field].length > limit) {
      errors.push(`${field} must be under ${limit} characters`)
    }
  }

  return { errors, value }
}

module.exports = { validateSellerRequest }
