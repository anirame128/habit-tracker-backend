const express = require('express');
const userRoutes = require('./routes/userRoutes');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Middleware
app.use(express.json());

// Routes
app.use('/api', userRoutes);

app.get('/', (req, res) => {
    res.send('Welcome to the Habit Tracker API');
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on PORT: ${PORT}`);
});
