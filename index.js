const express = require('express');
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('This is MunchXpress Server!')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})