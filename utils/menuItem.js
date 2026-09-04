const maxLengths = {
  name: 100,
  description: 500,
  category: 60,
  imageURL: 500,
}

const categories = [
  'Rice & Biryani',
  'Curry',
  'Burger',
  'Pizza',
  'Pasta',
  'Noodles',
  'Sandwich & Wrap',
  'Kebab & Grill',
  'Snacks',
  'Salad',
  'Soup',
  'Seafood',
  'Dessert',
  'Beverage',
  'Other',
]

const maxPrice = 100000

const clean = (value) => (typeof value === 'string' ? value.trim() : '')

const toPrice = (value) => {
  if (value === '' || value === null || value === undefined) return NaN

  const amount = Number(value)

  if (!Number.isFinite(amount)) return NaN

  return Math.round(amount * 100) / 100
}

const validateMenuItem = (body = {}, { partial = false } = {}) => {
  const errors = []
  const value = {}

  const wants = (field) => !partial || Object.prototype.hasOwnProperty.call(body, field)

  if (wants('name')) {
    value.name = clean(body.name)

    if (value.name.length < 2) errors.push('Item name is required')
  }

  if (wants('price')) {
    value.price = toPrice(body.price)

    if (Number.isNaN(value.price)) {
      errors.push('Price must be a number')
    } else if (value.price <= 0) {
      errors.push('Price must be greater than 0')
    } else if (value.price > maxPrice) {
      errors.push(`Price must be under ${maxPrice}`)
    }
  }

  if (wants('category')) {
    value.category = clean(body.category)

    if (!value.category) {
      errors.push('Category is required')
    } else if (!categories.includes(value.category)) {
      errors.push('Category is not one of the allowed categories')
    }
  }

  if (wants('description')) value.description = clean(body.description)
  if (wants('imageURL')) value.imageURL = clean(body.imageURL)

  /*
    A dish with no picture is allowed -- a seller can add the menu first and
    photograph it later, and the cards fall back to a placeholder. Only an
    explicit imageURL is checked for length.
  */

  if (wants('available')) {
    value.available = body.available === undefined ? true : Boolean(body.available)
  }

  for (const [field, limit] of Object.entries(maxLengths)) {
    if (typeof value[field] === 'string' && value[field].length > limit) {
      errors.push(`${field} must be under ${limit} characters`)
    }
  }

  /* nothing to write, which for a PATCH means the body held no known field */
  if (partial && Object.keys(value).length === 0) {
    errors.push('Nothing to update')
  }

  return { errors, value }
}

module.exports = { validateMenuItem, categories, maxPrice }
