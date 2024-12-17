const neo4j = require('neo4j-driver');
require('dotenv').config();

// AuraDB Connection Details
const uri = process.env.AURA_URI; // AuraDB URI
const user = process.env.AURA_USER; // Username for AuraDB
const password = process.env.AURA_PASSWORD; // Password for AuraDB

// Initialize the Neo4j Driver
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

// Export the driver
module.exports = driver;
