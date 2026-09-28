const storeId = process.env.SSLC_STORE_ID || ''
const storePassword = process.env.SSLC_STORE_PASSWORD || ''

const isLive = String(process.env.SSLC_LIVE || '').toLowerCase() === 'true'

const sslcHost = isLive
  ? 'https://securepay.sslcommerz.com'
  : 'https://sandbox.sslcommerz.com'

const hasSslCredentials = Boolean(storeId && storePassword)

const provider = (() => {
  const wanted = (process.env.PAYMENT_PROVIDER || '').trim().toLowerCase()

  if (wanted === 'sslcommerz' || wanted === 'mock') return wanted

  return hasSslCredentials ? 'sslcommerz' : 'mock'
})()

/* where the gateway sends the customer back to, and where the mock page lives */
const clientUrl = ( process.env.SITE_DOMAIN || 'http://localhost:5173')
  .replace(/\/+$/, '')

const serverUrl = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`)
  .replace(/\/+$/, '')

const paymentConfigError = () => {
  if (provider !== 'sslcommerz') return ''

  return hasSslCredentials
    ? ''
    : 'Online payment is not configured, SSLC_STORE_ID and SSLC_STORE_PASSWORD are missing'
}

const initiateMock = ({ checkoutId }) => ({
  provider: 'mock',
  redirectUrl: `${clientUrl}/checkout/pay/${checkoutId}`,
  transactionId: `MOCK-${checkoutId}`,
})


const initiateSslCommerz = async ({ checkoutId, amount, customer, itemCount }) => {
  const body = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    total_amount: String(amount),
    currency: 'BDT',
    tran_id: String(checkoutId),

    success_url: `${serverUrl}/payments/sslcommerz/return?outcome=success`,
    fail_url: `${serverUrl}/payments/sslcommerz/return?outcome=fail`,
    cancel_url: `${serverUrl}/payments/sslcommerz/return?outcome=cancel`,
    ipn_url: `${serverUrl}/payments/sslcommerz/ipn`,

    cus_name: customer.name,
    cus_email: customer.email,
    cus_phone: customer.phone,
    cus_add1: customer.address,
    cus_city: customer.city || 'Dhaka',
    cus_country: 'Bangladesh',

    shipping_method: 'YES',
    num_of_item: String(itemCount),
    ship_name: customer.name,
    ship_add1: customer.address,
    ship_city: customer.city || 'Dhaka',
    ship_country: 'Bangladesh',
    ship_postcode: customer.postcode || '1200',

    product_name: 'MunchXpress food order',
    product_category: 'Food',
    product_profile: 'general',
  })

  const response = await fetch(`${sslcHost}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const result = await response.json().catch(() => null)

  if (!response.ok || result?.status !== 'SUCCESS' || !result?.GatewayPageURL) {
    const reason = result?.failedreason || result?.status || `HTTP ${response.status}`

    throw new Error(`Could not start the payment: ${reason}`)
  }

  return {
    provider: 'sslcommerz',
    redirectUrl: result.GatewayPageURL,
    transactionId: String(checkoutId),
    sessionKey: result.sessionkey || '',
  }
}

const initiatePayment = async ({ checkoutId, amount, customer, itemCount }) => {
  const configError = paymentConfigError()

  if (configError) throw new Error(configError)

  if (provider === 'sslcommerz') {
    return initiateSslCommerz({ checkoutId, amount, customer, itemCount })
  }

  return initiateMock({ checkoutId })
}


const verifyPayment = async ({ checkoutId, outcome = 'success', validationId = '' }) => {
  if (provider === 'mock') {
    return {
      paid: outcome === 'success',
      amount: null,
      transactionId: `MOCK-${checkoutId}`,
      raw: { provider: 'mock', outcome },
    }
  }

  if (!validationId) {
    return { paid: false, amount: null, transactionId: String(checkoutId), raw: null }
  }

  const url = new URL(`${sslcHost}/validator/api/validationserverAPI.php`)

  url.searchParams.set('val_id', validationId)
  url.searchParams.set('store_id', storeId)
  url.searchParams.set('store_passwd', storePassword)
  url.searchParams.set('format', 'json')

  const response = await fetch(url, { method: 'GET' })
  const result = await response.json().catch(() => null)

  /* VALID is a card payment, VALIDATED a settled one -- both mean paid */
  const paid = response.ok
    && ['VALID', 'VALIDATED'].includes(result?.status)
    && String(result?.tran_id) === String(checkoutId)

  return {
    paid,
    amount: Number(result?.amount) || null,
    transactionId: result?.bank_tran_id || String(checkoutId),
    raw: result,
  }
}

module.exports = {
  provider,
  clientUrl,
  hasSslCredentials,
  paymentConfigError,
  initiatePayment,
  verifyPayment,
}
