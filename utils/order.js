const crypto = require('node:crypto')

const deliveryFee = 50

const maxLengths = {
  name: 100,
  phone: 30,
  address: 300,
  note: 300,
}

const orderStatuses = [
  'awaiting_payment',
  'placed',
  'accepted',
  'rejected',
  'completed',
  'cancelled',
]

/* the ones still in play, which is what the seller's queue and the badge count */
const openStatuses = ['placed', 'accepted']

const paymentMethods = ['cod', 'online']

const paymentStatuses = ['unpaid', 'pending', 'paid', 'failed', 'refund_due']

const round2 = (value) => Math.round(value * 100) / 100

const clean = (value) => (typeof value === 'string' ? value.trim() : '')

/* same loose rule as the client and utils/sellerRequest, digits only counted */
const isValidPhone = (phone) => {
  if (!/^[\d\s+()-]+$/.test(phone)) return false

  const digits = phone.replace(/\D/g, '')

  return digits.length >= 7 && digits.length <= 15
}

const validateCheckout = (body = {}) => {
  const value = {
    paymentMethod: clean(body.paymentMethod),
    name: clean(body.name),
    phone: clean(body.phone),
    address: clean(body.address),
    note: clean(body.note),
  }

  const errors = []

  if (!paymentMethods.includes(value.paymentMethod)) {
    errors.push("Payment method must be either 'cod' or 'online'")
  }

  if (value.name.length < 2) {
    errors.push('A name for the delivery is required')
  }

  if (!value.phone) {
    errors.push('Phone number is required')
  } else if (!isValidPhone(value.phone)) {
    errors.push('Phone number is not a valid number')
  }

  if (value.address.length < 10) {
    errors.push('Please give a full delivery address')
  }

  for (const [field, limit] of Object.entries(maxLengths)) {
    if (value[field].length > limit) {
      errors.push(`${field} must be under ${limit} characters`)
    }
  }

  return { errors, value }
}

const orderNumberAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

const makeOrderNumber = () => {
  let code = ''

  for (let i = 0; i < 6; i += 1) {
    code += orderNumberAlphabet[crypto.randomInt(orderNumberAlphabet.length)]
  }

  return `MX-${code}`
}

const groupByRestaurant = (items = []) => {
  const byRestaurant = new Map()

  for (const line of items) {
    const key = String(line.restaurantId)

    if (!byRestaurant.has(key)) {
      byRestaurant.set(key, {
        restaurantId: line.restaurantId,
        restaurantName: line.restaurantName,
        items: [],
      })
    }

    byRestaurant.get(key).items.push({
      menuItemId: line.menuItemId,
      name: line.name,
      price: line.price,
      quantity: line.quantity,
      imageURL: line.imageURL || '',
      category: line.category || '',
      lineTotal: round2(line.price * line.quantity),
    })
  }

  return [...byRestaurant.values()].map((group) => {
    const itemsTotal = round2(
      group.items.reduce((sum, line) => sum + line.lineTotal, 0)
    )

    return {
      ...group,
      itemsTotal,
      deliveryFee,
      total: round2(itemsTotal + deliveryFee),
    }
  })
}

/* what the customer is asked to pay for the whole checkout, all restaurants */
const checkoutTotal = (groups = []) => round2(
  groups.reduce((sum, group) => sum + group.total, 0)
)

const forCustomer = (order) => {
  const { ownerEmail, payment, ...rest } = order

  return {
    ...rest,
    payment: payment ? { provider: payment.provider, paidAt: payment.paidAt || null } : null,
  }
}

module.exports = {
  deliveryFee,
  orderStatuses,
  openStatuses,
  paymentMethods,
  paymentStatuses,
  validateCheckout,
  makeOrderNumber,
  groupByRestaurant,
  checkoutTotal,
  forCustomer,
  round2,
  isValidPhone,
}
