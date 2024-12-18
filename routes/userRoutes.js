const express = require('express');
const router = express.Router();
const driver = require('../db/neo4j');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require("nodemailer");
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const SECRET_KEY = process.env.JWT_SECRET_KEY
let verificationCodes = {};
let userDataStore = {};

// Rate limiter for email requests
const emailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 requests per 15 minutes
    message: "Too many email requests, please try again later.",
});

// Authentication JWT Token
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded; // Attach user info to the request
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};
const transporter = nodemailer.createTransport({
    service: 'gmail', // Using Gmail
    auth: {
      user: process.env.EMAIL_USER, // Your Gmail address
      pass: process.env.EMAIL_PASS, // App password or regular password
    },
});

// GET: Gets all the habits
router.get('/habits', async (req, res) => {
    const session = driver.session(); // Create a new session for this request
    try {
        const result = await session.run('MATCH (h:Habit) RETURN h');
        const habits = result.records.map(record => record.get('h').properties);
        res.status(200).json(habits);
    } catch (error) {
        console.error('Error fetching habits:', error);
        res.status(500).json({ error: 'Failed to fetch habits' });
    } finally {
        await session.close(); // Close the session after the request is complete
    }
});

// POST: Save user's selected habits
router.post('/save-habits', authenticateToken, async (req, res) => {
    const { habits } = req.body; // Array of habit names
    const { userId } = req.user; // Extract userId from JWT token

    if (!habits || !Array.isArray(habits) || habits.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty habit list' });
    }

    const session = driver.session();
    try {
        // Start a transaction
        const tx = session.beginTransaction();

        // Loop through each habit and create the relationship
        for (const habit of habits) {
            await tx.run(
                `
                MATCH (u:User {id: $userId}), (h:Habit {name: $habitName})
                MERGE (u)-[:HAS]->(h)
                RETURN h
                `,
                { userId, habitName: habit }
            );
        }

        // Commit the transaction
        await tx.commit();
        res.status(200).json({ message: 'Habits saved successfully!' });
    } catch (error) {
        console.error('Error saving habits:', error);
        res.status(500).json({ error: 'Failed to save habits' });
    } finally {
        await session.close();
    }
});

// GET: Fetch habits for the authenticated user
router.get('/user-habits', authenticateToken, async (req, res) => {
    const { userId } = req.user; // Extract userId from JWT token

    const session = driver.session();
    try {
        const result = await session.run(
            `
            MATCH (u:User {id: $userId})-[:HAS]->(h:Habit)
            RETURN h.name AS habitName
            `,
            { userId }
        );

        const habits = result.records.map(record => record.get('habitName'));
        res.status(200).json({ habits });
    } catch (error) {
        console.error('Error fetching user habits:', error);
        res.status(500).json({ error: 'Failed to fetch user habits' });
    } finally {
        await session.close();
    }
});

// POST: Register a user on the platform
router.post('/register', async (req, res) => {
    const { firstName, lastName, email, password, confirmEmail, confirmPassword } = req.body;

    // Validation
    const validateInputs = () => {
        if (!validator.isEmail(email)) {
            return "Invalid email address";
        }
        if (email !== confirmEmail) {
            return "Emails do not match";
        }
        if (password !== confirmPassword) {
            return "Passwords do not match";
        }
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        if (!passwordRegex.test(password)) {
            return "Password must be at least 8 characters, include uppercase, lowercase, numbers, and symbols";
        }
        return null;
    };

    const validationError = validateInputs();
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    const session = driver.session();
    try {
        // Check if email already exists
        const emailCheckQuery = 'MATCH (u:User {email: $email}) RETURN u';
        const result = await session.run(emailCheckQuery, { email });

        if (result.records.length > 0) {
            // If email exists, send a specific error response
            return res.status(409).json({ error: "Email is already registered" }); // 409 Conflict
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate verification code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        userDataStore[email] = { firstName, lastName, password: hashedPassword };
        verificationCodes[email] = verificationCode;

        // Expire verification code after 10 minutes
        setTimeout(() => {
            delete verificationCodes[email];
        }, 10 * 60 * 1000);

        // Send verification email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'HabitSphere Email Verification',
            text: `Your verification code is: ${verificationCode}`,
        };

        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: "Verification code sent to email" });
    } catch (err) {
        console.error("Registration Error:", err);
        res.status(500).json({ error: "An unexpected error occurred during registration" });
    } finally {
        await session.close();
    }
});

// POST: Verify a users email while registering
router.post('/verify-email', async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ error: "Email and verification code are required" });
    }

    const storedCode = verificationCodes[email];
    const userData = userDataStore[email];

    if (!storedCode) {
        return res.status(400).json({ error: "No verification code found for this email" });
    }

    if (storedCode !== code) {
        return res.status(400).json({ error: "Invalid verification code" });
    }

    const session = driver.session();
    try {
        const createUserQuery = `
            CREATE (u:User {
                id: randomUUID(),
                firstName: $firstName,
                lastName: $lastName,
                email: $email,
                username: "pending_username",
                password: $password,
                createdAt: datetime()
            })
            RETURN u.id AS userId
        `;

        const result = await session.run(createUserQuery, {
            firstName: userData.firstName,
            lastName: userData.lastName,
            email,
            password: userData.password,
        });

        const userId = result.records[0].get('userId');
        delete verificationCodes[email];
        delete userDataStore[email];

        const token = jwt.sign({ userId, email }, SECRET_KEY, { expiresIn: '1h' });
        res.status(200).json({ message: "Email verified and user created successfully", token });
    } catch (err) {
        console.error("Error creating user:", err);
        res.status(500).json({ error: "Failed to create user in the database" });
    } finally {
        await session.close();
    }
});

// POST: Sign-in a user to the platform
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    //console.log(email, password);
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }

    const session = driver.session();
    try {
        const query = `
            MATCH (u:User {email: $email})
            RETURN u.password AS hashedPassword, u.id AS userId, u.firstName AS firstName, u.lastName AS lastName
        `;
        const result = await session.run(query, { email });

        if (result.records.length === 0) {
            return res.status(400).json({ error: "Invalid email or password" });
        }

        const { hashedPassword, userId, firstName, lastName } = result.records[0].toObject();
        const passwordMatch = await bcrypt.compare(password, hashedPassword);

        if (!passwordMatch) {
            return res.status(400).json({ error: "Invalid email or password" });
        }

        const token = jwt.sign({ userId, email }, SECRET_KEY, { expiresIn: '1h' });
        res.status(200).json({ message: "Login successful", token, user: { firstName, lastName, email } });
    } catch (err) {
        console.error("Error during sign-in:", err);
        res.status(500).json({ error: "An unexpected error occurred during sign-in" });
    } finally {
        await session.close();
    }
});

// POST: Log-out a user from platform
router.post('/logout', async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1]; // Extract token

    if (!token) {
        return res.status(400).json({ error: "Token is required for logout" });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY); // Verify token

        // Optionally handle token blacklisting here
        res.status(200).json({ message: "Logout successful" });
    } catch (err) {
        console.error("Error during logout:", err);

        if (err.name === "TokenExpiredError") {
            return res.status(400).json({ error: "Token has already expired" });
        }

        res.status(500).json({ error: "An unexpected error occurred during logout" });
    }
});


// PUT: Update User-Name for new User
router.put('/update-username', authenticateToken, async (req, res) => {
    const { username } = req.body;
    const { userId } = req.user;

    if (!username || username.length < 8 || /[^a-zA-Z0-9_-]/.test(username)) {
        return res.status(400).json({ error: 'Invalid username.' });
    }

    const session = driver.session();
    try {
        const existingUserResult = await session.run('MATCH (u:User {username: $username}) RETURN u', { username });
        if (existingUserResult.records.length > 0) {
            return res.status(400).json({ error: 'Username is already taken.' });
        }

        const updateResult = await session.run(
            'MATCH (u:User {id: $userId}) SET u.username = $username RETURN u',
            { userId, username }
        );

        if (updateResult.records.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json({ message: 'Username updated successfully.' });
    } catch (error) {
        console.error('Error updating username:', error);
        res.status(500).json({ error: 'An error occurred while updating the username.' });
    } finally {
        await session.close();
    }
});

  
// POST: Create a Friend Request
// router.post('/friend-request', async (req, res) => {
//     const { fromUsername, toUsername } = req.body;

//     if (!fromUsername || !toUsername) {
//         return res.status(400).json({ error: 'Both fromUsername and toUsername are required.' });
//     }

//     try {
//         const query = `
//             MATCH (from:User {unique_username: $fromUsername}), (to:User {unique_username: $toUsername})
//             MERGE (from)-[:FRIEND_REQUEST {status: "PENDING"}]->(to)
//             RETURN from, to
//         `;

//         await session.run(query, { fromUsername, toUsername });
//         res.status(201).json({ message: 'Friend request sent.' });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: 'An error occurred while sending the friend request.' });
//     }
// });

// // PUT: Accept a Friend Request
// router.put('/friend-request/accept', async (req, res) => {
//     const { fromUsername, toUsername } = req.body;

//     if (!fromUsername || !toUsername) {
//         return res.status(400).json({ error: 'Both fromUsername and toUsername are required.' });
//     }

//     try {
//         const query = `
//             MATCH (from:User {unique_username: $fromUsername})-[r:FRIEND_REQUEST {status: "PENDING"}]->(to:User {unique_username: $toUsername})
//             DELETE r
//             CREATE (from)-[:FRIENDS_WITH]->(to)
//             CREATE (to)-[:FRIENDS_WITH]->(from)
//             RETURN from, to
//         `;

//         await session.run(query, { fromUsername, toUsername });
//         res.status(200).json({ message: 'Friend request accepted. Users are now friends.' });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: 'An error occurred while accepting the friend request.' });
//     }
// });

// // DELETE: Reject a Friend Request
// router.delete('/friend-request/reject', async (req, res) => {
//     const { fromUsername, toUsername } = req.body;

//     if (!fromUsername || !toUsername) {
//         return res.status(400).json({ error: 'Both fromUsername and toUsername are required.' });
//     }

//     try {
//         const query = `
//             MATCH (from:User {unique_username: $fromUsername})-[r:FRIEND_REQUEST {status: "PENDING"}]->(to:User {unique_username: $toUsername})
//             DELETE r
//             RETURN from, to
//         `;

//         await session.run(query, { fromUsername, toUsername });
//         res.status(200).json({ message: 'Friend request rejected.' });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: 'An error occurred while rejecting the friend request.' });
//     }
// });

// // DELETE: Unfriend another user
// router.delete('/unfriend', async (req, res) => {
//     const { user1Username, user2Username } = req.body;

//     if (!user1Username || !user2Username) {
//         return res.status(400).json({ error: 'Both user1Username and user2Username are required.' });
//     }

//     try {
//         const query = `
//             MATCH (u1:User {unique_username: $user1Username})-[r:FRIENDS_WITH]-(u2:User {unique_username: $user2Username})
//             DELETE r
//             RETURN u1, u2
//         `;

//         const result = await session.run(query, { user1Username, user2Username });

//         if (result.records.length === 0) {
//             return res.status(404).json({ error: 'No friendship exists between the specified users.' });
//         }

//         res.status(200).json({ message: 'Friendship removed successfully.' });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: 'An error occurred while removing the friendship.' });
//     }
// });

module.exports = router;