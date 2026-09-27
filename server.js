const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleAuth } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// GOOGLE WALLET CONFIGURATION
// ============================================================

const ISSUER_ID =
  process.env.GOOGLE_WALLET_ISSUER_ID ||
  '3388000000023206123';

// IMPORTANT:
// This Class already exists in your Google Wallet Business Console.
const CLASS_ID = `${ISSUER_ID}.otacos_loyalty_card`;

const GOOGLE_WALLET_API =
  'https://walletobjects.googleapis.com/walletobjects/v1';


// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// ============================================================
// EXPRESS
// ============================================================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ============================================================
// GOOGLE SERVICE ACCOUNT
// ============================================================

function getServiceAccountCredentials() {
  // Production / Render / Railway / Vercel etc.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const credentials = JSON.parse(
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY
      );

      if (credentials.private_key) {
        credentials.private_key =
          credentials.private_key.replace(/\\n/g, '\n');
      }

      return credentials;

    } catch (error) {
      console.error(
        'ERROR parsing GOOGLE_SERVICE_ACCOUNT_KEY:',
        error
      );

      return null;
    }
  }

  // Local VS Code development
  try {
    return require(
      path.join(__dirname, 'service-account.json')
    );
  } catch (error) {
    console.error(
      'service-account.json was not found.'
    );

    return null;
  }
}


// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

function getGoogleAuth() {
  const credentials = getServiceAccountCredentials();

  if (!credentials) {
    throw new Error(
      'Google service account credentials are missing.'
    );
  }

  return new GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/wallet_object.issuer'
    ]
  });
}


// ============================================================
// CREATE A STABLE GOOGLE WALLET OBJECT ID
// ============================================================
//
// IMPORTANT:
//
// DO NOT use Date.now() here.
//
// The same customer must always have the same Wallet Object.
//
// Example:
//
// 3388000000023206123.customer_12345678
//
// This allows the same Google Wallet card to be updated later.
// ============================================================

function getWalletObjectId(phone) {
  const cleanPhone = String(phone)
    .replace(/\D/g, '');

  return `${ISSUER_ID}.customer_${cleanPhone}`;
}


// ============================================================
// CREATE GOOGLE WALLET LOYALTY OBJECT
// ============================================================

function createLoyaltyObject(client) {
  const phone = String(client.phone).replace(/\D/g, '');

  const objectId = getWalletObjectId(phone);

  return {
    id: objectId,

    classId: CLASS_ID,

    state: 'ACTIVE',

    accountName:
      client.name || "Client O'Tacos",

    accountId: phone,

    // ========================================================
    // THIS CREATES THE QR CODE
    // ========================================================
    barcode: {
      type: 'QR_CODE',
      value: phone,
      alternateText: phone
    },

    // ========================================================
    // POINTS
    // ========================================================
    loyaltyPoints: {
      label: 'Points',
      balance: {
        int: Number(client.points || 0)
      }
    },

    // ========================================================
    // CUSTOMER NAME
    // ========================================================
    textModulesData: [
      {
        id: 'member_name',
        header: 'Membre',
        body: client.name || "Client O'Tacos"
      }
    ]
  };
}


// ============================================================
// GENERATE "ADD TO GOOGLE WALLET" URL
// ============================================================
//
// Because your Class already exists, we only send the
// Loyalty Object in the JWT.
//
// Google Wallet will associate the Object with your existing
// Class.
//
// ============================================================

function generateGoogleWalletUrl(client) {
  const credentials = getServiceAccountCredentials();

  if (!credentials) {
    console.error(
      'Cannot generate Wallet URL: credentials missing.'
    );

    return null;
  }

  try {
    const loyaltyObject = createLoyaltyObject(client);

    const claims = {
      iss: credentials.client_email,

      aud: 'google',

      typ: 'savetowallet',

      // Google recommends including the issued-at time.
      iat: Math.floor(Date.now() / 1000),

      // Keep this empty for a normal web/email/SMS
      // Add to Google Wallet flow.
      origins: [],

      payload: {
        loyaltyObjects: [
          loyaltyObject
        ]
      }
    };

    const token = jwt.sign(
      claims,
      credentials.private_key,
      {
        algorithm: 'RS256'
      }
    );

    const walletUrl =
      `https://pay.google.com/gp/v/save/${token}`;

    return walletUrl;

  } catch (error) {
    console.error(
      'ERROR generating Google Wallet JWT:',
      error
    );

    return null;
  }
}


// ============================================================
// UPDATE EXISTING GOOGLE WALLET OBJECT
// ============================================================
//
// This is important.
//
// Generating another Save URL does NOT mean that the card
// already saved in the customer's Google Wallet gets updated.
//
// When points change, we update the existing Wallet Object.
//
// ============================================================

async function updateGoogleWalletObject(client) {
  try {
    const auth = getGoogleAuth();

    const clientAuth = await auth.getClient();

    const accessTokenResponse =
      await clientAuth.getAccessToken();

    const accessToken =
      accessTokenResponse.token;

    if (!accessToken) {
      throw new Error(
        'Could not obtain Google access token.'
      );
    }

    const loyaltyObject =
      createLoyaltyObject(client);

    const objectId =
      loyaltyObject.id;

    const url =
      `${GOOGLE_WALLET_API}/loyaltyObject/${encodeURIComponent(objectId)}`;

    const response = await fetch(url, {
      method: 'PUT',

      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(loyaltyObject)
    });

    const responseText =
      await response.text();

    if (!response.ok) {

      // If the customer has never saved the card,
      // the object may not exist yet.
      if (response.status === 404) {
        console.log(
          `Wallet object ${objectId} does not exist yet.`
        );

        return {
          success: false,
          notCreatedYet: true
        };
      }

      console.error(
        'Google Wallet API error:',
        response.status,
        responseText
      );

      throw new Error(
        `Google Wallet API returned ${response.status}: ${responseText}`
      );
    }

    console.log(
      `Google Wallet object updated: ${objectId}`
    );

    return {
      success: true,
      object: JSON.parse(responseText)
    };

  } catch (error) {

    console.error(
      'ERROR updating Google Wallet object:',
      error
    );

    return {
      success: false,
      error: error.message
    };
  }
}


// ============================================================
// GET CLIENT PAGE
// ============================================================

app.get('/client', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'client.html')
  );
});


// ============================================================
// GET ADMIN PAGE
// ============================================================

app.get('/admin', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'admin.html')
  );
});


// ============================================================
// DATABASE TEST
// ============================================================

app.get('/api/db-test', async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT
        NOW() AS current_time,
        current_database() AS db_name
      `
    );

    res.json({
      status: 'Connected',
      database: result.rows[0].db_name,
      time: result.rows[0].current_time
    });

  } catch (error) {

    console.error(
      'Database connection error:',
      error
    );

    res.status(500).json({
      status: 'Disconnected',
      error: error.message
    });
  }
});


// ============================================================
// GET ALL CLIENTS
// ============================================================

app.get('/api/clients', async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM clients
      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);

  } catch (error) {

    console.error(
      'Database query error:',
      error
    );

    res.status(500).json({
      error: 'Database fetch failed'
    });
  }
});


// ============================================================
// GET SINGLE CLIENT
// ============================================================

app.get('/api/client/:phone', async (req, res) => {

  const phone = req.params.phone.trim();

  if (!/^\d{8}$/.test(phone)) {

    return res.status(400).json({
      error:
        'Phone number must be exactly 8 digits.'
    });
  }

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM clients
      WHERE phone = $1
      `,
      [phone]
    );

    if (result.rows.length === 0) {

      return res.status(404).json({
        error: 'Client not found.'
      });
    }

    const client = result.rows[0];

    const walletUrl =
      generateGoogleWalletUrl(client);

    res.json({
      ...client,

      walletUrl,

      walletObjectId:
        getWalletObjectId(client.phone)
    });

  } catch (error) {

    console.error(
      'Database query error:',
      error
    );

    res.status(500).json({
      error: 'Database lookup failed'
    });
  }
});


// ============================================================
// REGISTER NEW CLIENT
// ============================================================

app.post('/api/clients', async (req, res) => {

  const phone =
    String(req.body.phone || '').trim();

  const name =
    String(req.body.name || '').trim();


  // ----------------------------------------------------------
  // PHONE VALIDATION
  // ----------------------------------------------------------

  if (!/^\d{8}$/.test(phone)) {

    return res.status(400).json({
      error:
        'Phone number must be exactly 8 digits.'
    });
  }


  // ----------------------------------------------------------
  // NAME VALIDATION
  // ----------------------------------------------------------

  const words =
    name ? name.split(/\s+/) : [];

  if (words.length !== 3) {

    return res.status(400).json({
      error:
        'Client name must contain exactly 3 words.'
    });
  }


  try {

    // --------------------------------------------------------
    // CHECK DUPLICATE PHONE
    // --------------------------------------------------------

    const checkUser =
      await pool.query(
        `
        SELECT *
        FROM clients
        WHERE phone = $1
        `,
        [phone]
      );

    if (checkUser.rows.length > 0) {

      return res.status(400).json({
        error:
          'A client with this phone number already exists.'
      });
    }


    // --------------------------------------------------------
    // CREATE CLIENT
    // --------------------------------------------------------

    const insertResult =
      await pool.query(
        `
        INSERT INTO clients
          (phone, name, points)
        VALUES
          ($1, $2, $3)
        RETURNING *
        `,
        [
          phone,
          name,
          0
        ]
      );

    const newClient =
      insertResult.rows[0];


    // --------------------------------------------------------
    // GENERATE GOOGLE WALLET URL
    // --------------------------------------------------------

    const walletUrl =
      generateGoogleWalletUrl(newClient);


    res.status(201).json({

      ...newClient,

      walletUrl,

      walletObjectId:
        getWalletObjectId(newClient.phone)

    });

  } catch (error) {

    console.error(
      'Database insert error:',
      error
    );

    res.status(500).json({
      error:
        'Failed to create client in database'
    });
  }
});


// ============================================================
// UPDATE POINTS
// ============================================================

app.post('/api/points', async (req, res) => {

  const phone =
    String(req.body.phone || '').trim();

  const delta =
    Number.parseInt(req.body.delta, 10);


  // ----------------------------------------------------------
  // VALIDATE PHONE
  // ----------------------------------------------------------

  if (!/^\d{8}$/.test(phone)) {

    return res.status(400).json({
      error:
        'Phone number must be exactly 8 digits.'
    });
  }


  // ----------------------------------------------------------
  // VALIDATE DELTA
  // ----------------------------------------------------------

  if (!Number.isInteger(delta)) {

    return res.status(400).json({
      error:
        'Points change must be an integer.'
    });
  }


  try {

    // --------------------------------------------------------
    // FIND CLIENT
    // --------------------------------------------------------

    const userResult =
      await pool.query(
        `
        SELECT *
        FROM clients
        WHERE phone = $1
        `,
        [phone]
      );

    if (userResult.rows.length === 0) {

      return res.status(404).json({
        error: 'Client not found.'
      });
    }


    const client =
      userResult.rows[0];


    // --------------------------------------------------------
    // CALCULATE NEW POINTS
    // --------------------------------------------------------

    let updatedPoints =
      Number(client.points || 0) + delta;


    // Minimum 0
    if (updatedPoints < 0) {
      updatedPoints = 0;
    }


    // Maximum 100
    if (updatedPoints > 100) {
      updatedPoints = 100;
    }


    // --------------------------------------------------------
    // UPDATE DATABASE
    // --------------------------------------------------------

    const updateResult =
      await pool.query(
        `
        UPDATE clients
        SET points = $1
        WHERE phone = $2
        RETURNING *
        `,
        [
          updatedPoints,
          phone
        ]
      );


    const updatedClient =
      updateResult.rows[0];


    // --------------------------------------------------------
    // UPDATE GOOGLE WALLET
    // --------------------------------------------------------

    const walletUpdate =
      await updateGoogleWalletObject(
        updatedClient
      );


    // --------------------------------------------------------
    // GENERATE NEW SAVE URL
    //
    // This is useful if the customer has not saved the card
    // yet, or wants to add it again.
    // --------------------------------------------------------

    const walletUrl =
      generateGoogleWalletUrl(
        updatedClient
      );


    res.json({

      success: true,

      points:
        updatedClient.points,

      walletUrl,

      walletObjectId:
        getWalletObjectId(
          updatedClient.phone
        ),

      walletUpdated:
        walletUpdate.success,

      walletObjectNotCreatedYet:
        walletUpdate.notCreatedYet || false

    });

  } catch (error) {

    console.error(
      'Database update error:',
      error
    );

    res.status(500).json({
      error:
        'Failed to update points.'
    });
  }
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `O'Tacos Loyalty Server running on port ${PORT}`
  );

  console.log(
    `Google Wallet Class: ${CLASS_ID}`
  );

});
