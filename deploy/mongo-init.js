// Runs only when the MongoDB volume is first initialized.
db.getSiblingDB('codeforge').createUser({
  user: 'codeforge',
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: 'codeforge' }],
});
