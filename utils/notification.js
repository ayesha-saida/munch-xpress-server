const notificationTypes = [
  'order_placed',     // to the seller: someone ordered from you
  'order_accepted',   // to the customer: the kitchen took it
  'order_rejected',   // to the customer: the kitchen turned it down
  'order_completed',  // to the customer: delivered
  'order_cancelled',  // to the seller: the customer pulled out
]

const currency = (amount) => `৳${Number.isInteger(amount) ? amount : Number(amount).toFixed(2)}`

const countOf = (order) => {
  const count = order.items.reduce((sum, line) => sum + line.quantity, 0)

  return `${count} ${count === 1 ? 'item' : 'items'}`
}

const build = ({ email, role, type, title, body, order, link }) => ({
  email,
  role,
  type,
  title,
  body,
  orderId: order._id,
  orderNumber: order.orderNumber,
  link,
  read: false,
  createdAt: new Date(),
})

/* to the seller, the moment an order becomes payable work */
const orderPlacedForSeller = (order) => build({
  email: order.ownerEmail,
  role: 'seller',
  type: 'order_placed',
  title: `New order ${order.orderNumber}`,
  body: `${order.delivery.name} ordered ${countOf(order)} for ${currency(order.total)}`
    + `${order.paymentMethod === 'cod' ? ', cash on delivery' : ', already paid'}.`,
  order,
  link: '/dashboard/orders',
})

const orderAcceptedForCustomer = (order) => build({
  email: order.customerEmail,
  role: 'customer',
  type: 'order_accepted',
  title: `${order.restaurantName} accepted your order`,
  body: `${order.orderNumber} is being prepared.`
    + (order.sellerNote ? ` They said: ${order.sellerNote}` : ''),
  order,
  link: '/dashboard/my-orders',
})

const orderRejectedForCustomer = (order) => build({
  email: order.customerEmail,
  role: 'customer',
  type: 'order_rejected',
  title: `${order.restaurantName} could not take your order`,
  body: (order.sellerNote ? `They said: ${order.sellerNote}` : 'No reason was given.')
    + (order.paymentStatus === 'refund_due'
      ? ` Your ${currency(order.total)} payment will be refunded.`
      : ''),
  order,
  link: '/dashboard/my-orders',
})

const orderCompletedForCustomer = (order) => build({
  email: order.customerEmail,
  role: 'customer',
  type: 'order_completed',
  title: `${order.orderNumber} was delivered`,
  body: `Enjoy your food from ${order.restaurantName}.`,
  order,
  link: '/dashboard/my-orders',
})

const orderCancelledForSeller = (order) => build({
  email: order.ownerEmail,
  role: 'seller',
  type: 'order_cancelled',
  title: `${order.orderNumber} was cancelled`,
  body: `${order.delivery.name} cancelled before you answered, so there is nothing to cook.`,
  order,
  link: '/dashboard/orders',
})

module.exports = {
  notificationTypes,
  orderPlacedForSeller,
  orderAcceptedForCustomer,
  orderRejectedForCustomer,
  orderCompletedForCustomer,
  orderCancelledForSeller,
}
