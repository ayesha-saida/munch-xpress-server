const { ObjectId } = require('mongodb')

const maxQuantity = 99

const normalizeQuantity = (value) => {
  const quantity = Number(value)

  if (!Number.isFinite(quantity)) return null

  const whole = Math.trunc(quantity)

  if (whole < 1) return null

  return Math.min(whole, maxQuantity)
}

/* shared by every cart route, so a bad id is a 400 rather than a thrown BSONError */
const toMenuItemId = (value) => (ObjectId.isValid(value) ? new ObjectId(value) : null)

const hydrateCart = async (cart, menuItemCollection) => {
  const lines = Array.isArray(cart?.items) ? cart.items : []

  if (lines.length === 0) {
    return { items: [], subtotal: 0, removed: [], staleIds: [] }
  }

  const ids = lines.map((line) => line.menuItemId).filter(Boolean)

  const dishes = await menuItemCollection.find({ _id: { $in: ids } }).toArray()

  // keyed by string, since two ObjectIds for the same id are not === each other
  const byId = new Map(dishes.map((dish) => [String(dish._id), dish]))

  const items = []
  const removed = []
  const staleIds = []

  for (const line of lines) {
    const dish = byId.get(String(line.menuItemId))

    /* deleted by its seller, or pulled from the menu since it was added */
    if (!dish || dish.available === false) {
      removed.push(dish?.name || 'An item')
      staleIds.push(line.menuItemId)
      continue
    }

    items.push({
      menuItemId: dish._id,
      quantity: line.quantity,
      addedAt: line.addedAt,
      name: dish.name,
      price: dish.price,
      imageURL: dish.imageURL,
      category: dish.category,
      restaurantId: dish.restaurantId,
      restaurantName: dish.restaurantName,
      lineTotal: Math.round(dish.price * line.quantity * 100) / 100,
    })
  }

  const subtotal = Math.round(
    items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
  ) / 100

  return { items, subtotal, removed, staleIds }
}

module.exports = { normalizeQuantity, toMenuItemId, hydrateCart, maxQuantity }
