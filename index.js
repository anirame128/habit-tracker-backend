const express = require('express');
const userRoutes = require('./routes/userRoutes');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', userRoutes);

app.get('/', (req, res) => {
    res.send('Welcome to the Habit Tracker API');
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on PORT: ${PORT}`);
});
