// server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 7777;
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift.json");
app.use(cors());
app.use(express.json());
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
const username = process.env.MONGO_USER;
const password = encodeURIComponent(process.env.MONGO_PASS);
const uri = `mongodb+srv://${username}:${password}@saikat.r5nuz5u.mongodb.net/?retryWrites=true&w=majority&appName=Saikat`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const parcelsCollection = client.db("zap_shift_user").collection("parcels");
    const trackCollection = client.db("zap_shift_user").collection("track");
    const userCollection = client.db("zap_shift_user").collection("users");
    const ridersCollection = client.db("zap_shift_user").collection("riders");
    const paymentCollection = client
      .db("zap_shift_user")
      .collection("payments");

    // GET parcels (optionally by user email), sorted by latest

    //custom middleware
    const verifyFireBaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization; // ✅ lowercase

      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Access Denied" });
      }

      const token = authHeader.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        console.error("Token verification error:", error.message);
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // verifyRider middleware
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // create user
    app.post("/users", async (req, res) => {
      try {
        const email = req.body.email;
        const userExists = await userCollection.findOne({ email });
        if (userExists) {
          return res
            .status(200)
            .send({ message: "User Already Exist", inserted: false });
        }
        const user = req.body;
        const result = await userCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        console.log(error.message);
      }
    });

    // GET /users/search?email=...
    app.get("/users/search", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: "Email is required" });

      try {
        // Partial, case-insensitive search
        const users = await userCollection
          .find({ email: { $regex: email, $options: "i" } })
          .toArray(); // Convert cursor to array

        if (!users.length)
          return res.status(404).json({ error: "No users found" });

        // Send minimal info
        const result = users.map((user) => ({
          _id: user._id,
          email: user.email,
          created_at: user.created_at,
          role: user.role || "user",
        }));

        res.json(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to search users" });
      }
    });

    // ✅ Update role by ID
    const ALLOWED_ROLES = ["admin", "user", "rider"];
    app.patch(
      "/users/:id/role",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;

        if (!ALLOWED_ROLES.includes(role)) {
          return res.status(400).json({ error: "Invalid role" });
        }

        try {
          const user = await userCollection.findOne({ _id: new ObjectId(id) });
          if (!user) return res.status(404).json({ error: "User not found" });

          await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );

          res.json({
            message: `User role updated from ${user.role} to ${role}`,
          });
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: "Failed to update user role" });
        }
      }
    );

    // ✅ 1. Get riders by district
    app.get("/riders", async (req, res) => {
      try {
        const { district } = req.query;
        let query = {};

        if (district) {
          // Use regex for case-insensitive match
          query.district = { $regex: `^${district}$`, $options: "i" };
        }

        const riders = await ridersCollection.find(query).toArray();
        res.json(riders);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch riders" });
      }
    });

    // ✅ 2. Assign rider to a parcel

    // PATCH /parcels/:id/assign-rider
    app.patch("/parcels/:id/assign-rider", async (req, res) => {
      const { id } = req.params;
      const { riderId, riderEmail, riderName } = req.body;

      const update = {
        assigned_rider: true,
        riderId,
        riderEmail,
        riderName,
        rider_status: "rider_assigned",
        assigned_at: new Date(), // ← store Picked At here
      };

      await parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: update }
      );

      res.json({ message: "Rider assigned and picked_at recorded" });
    });
    // PATCH /parcels/:id/cashout
    app.patch("/parcels/:id/cashout", async (req, res) => {
      try {
        const { id } = req.params;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        if (parcel.delivery_status !== "delivered") {
          return res.status(400).json({ message: "Parcel not delivered yet" });
        }

        if (parcel.cashout_status === "cashed_out") {
          return res.status(400).json({ message: "Parcel already cashed out" });
        }

        const cashoutTime = new Date();

        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashout_at: cashoutTime,
            },
          }
        );

        const updatedParcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        res.json({
          message: "Cashout successful",
          parcel: updatedParcel,
        });
      } catch (error) {
        console.error("Cashout error:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // PATCH /parcels/:id/assign-rider
    app.patch("/parcels/:id/assign-rider", async (req, res) => {
      try {
        const parcelId = req.params.id;
        const { riderId, riderName, riderEmail } = req.body;

        if (!riderId || !riderName || !riderEmail) {
          return res.status(400).json({ message: "Missing rider data" });
        }

        // 1️⃣ Update Parcel
        const parcelResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              riderId,
              riderName,
              riderEmail,
              rider_status: "rider_assigned", // ✅ add rider_status
              delivery_status: "in-transit",
              assigned_at: new Date(),
            },
          }
        );

        if (parcelResult.matchedCount === 0) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        // 2️⃣ Optional: Update Rider
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { rider_status: "rider_assigned" } }
        );

        res.json({ success: true, message: "Rider assigned successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    // GET role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        // find user by email
        const user = await userCollection.findOne(
          { email: email },
          { projection: { role: 1, email: 1 } } // only return role + email
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error fetching role:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // GET: Completed parcels for a rider by email

    app.get("/parcels", async (req, res) => {
      try {
        const { email, payment_status, delivery_status, search } = req.query;
        let query = {};

        // filter by creator email
        if (email) {
          query.created_by = email;
        }

        // filter by payment status
        if (payment_status) {
          query.payment_status = payment_status;
        }

        // filter by delivery status
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        // search functionality (case-insensitive regex)
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { sender_name: { $regex: search, $options: "i" } },
            { receiver_name: { $regex: search, $options: "i" } },
            { tracking_id: { $regex: search, $options: "i" } },
          ];
        }

        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 }) // latest first
          .toArray();

        res.json(parcels);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch parcels" });
      }
    });
    // GET /api/riders?status=approved&rider_status=available
    app.get("/api/riders", async (req, res) => {
      try {
        const query = {};
        if (req.query.status) query.status = req.query.status;
        if (req.query.rider_status) query.rider_status = req.query.rider_status;

        const riders = await ridersCollection.find(query).toArray();
        res.send(riders);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch riders" });
      }
    });

    // add a rider
    // GET /api/rider/completed-parcels?email=<riderEmail>
    app.get("/api/rider/completed-parcels", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email)
          return res.status(400).json({ message: "Email is required" });

        // Find parcels assigned to this rider
        const completedParcels = await parcelsCollection
          .find({
            riderEmail: email,
            delivery_status: { $in: ["delivered", "in-transit"] },
          })
          .toArray();

        // Add rider earning
        const parcelsWithEarnings = completedParcels.map((p) => {
          const cost = p.cost?.$numberInt
            ? Number(p.cost.$numberInt)
            : Number(p.cost);
          const earning =
            p.sender_region === p.receiver_region ? cost * 0.8 : cost * 0.3;
          return { ...p, rider_earning: earning };
        });

        res.json(parcelsWithEarnings);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // PATCH /api/parcels/:id/cashout

    // Express.js + MongoDB
    app.patch("/api/parcels/:id/cashout", async (req, res) => {
      try {
        const { id } = req.params;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        // Only allow cashout if not already cashed out
        if (parcel.cashout_status === "cashed_out") {
          return res.status(400).json({ message: "Parcel already cashed out" });
        }

        const updateResult = await parcelsCollection.findOneAndUpdate(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashout_at: new Date(),
            },
          },
          { returnDocument: "after" }
        );

        res.json({
          message: "Cashout successful",
          parcel: updateResult.value, // ✅ return updated parcel
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // PATCH /api/rider/:email/cashout-all

    app.get("/api/rider/completed-parcels", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email)
          return res.status(400).json({ message: "Email is required" });

        const completedParcels = await parcelsCollection
          .find({
            riderEmail: email,
            delivery_status: { $in: ["delivered", "in-transit"] },
          })
          .toArray();

        const parcelsWithExtras = completedParcels.map((p) => {
          // Parse cost
          const cost = p.cost?.$numberInt
            ? Number(p.cost.$numberInt)
            : Number(p.cost);

          // Calculate rider earning
          const riderEarning =
            p.sender_region === p.receiver_region ? cost * 0.8 : cost * 0.3;

          // Convert date fields
          const pickedAt = p.assigned_at?.$date
            ? new Date(p.assigned_at.$date.$numberLong)
            : null;
          const deliveredAt = p.delivered_at?.$date
            ? new Date(p.delivered_at.$date.$numberLong)
            : p.delivery_status === "delivered"
            ? new Date()
            : null; // or null if in-transit
          const creationDate = p.creation_date
            ? new Date(p.creation_date)
            : null;
          const cashedAt = p.cashed_at ? new Date(p.cashed_at) : null;

          return {
            ...p,
            cost,
            rider_earning: riderEarning,
            pickedAt,
            deliveredAt,
            creationDate,
            cashedAt,
          };
        });

        res.json(parcelsWithExtras);
      } catch (error) {
        console.error("Error fetching completed parcels:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // GET: Load completed parcel deliveries for a rider

    app.get(
      "/rider/completed-parcel",
      verifyFireBaseToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }
          const query = {
            riderEmail: email,
            delivery_status: {
              $in: ["delivered", "delivered"],
            },
          };

          const options = {
            sort: { creation_date: -1 },
          };
          const completedParcels = await parcelsCollection.find(query, options);
          res.send(completedParcels);
        } catch (error) {
          console.error("Error loading completed parcels:", error);
          res
            .status(500)
            .send({ message: "Failed to load completed deliveries" });
        }
      }
    );
    // Get all pending riders
    app.get(
      "/riders/pending",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const pendingRiders = await ridersCollection
            .find({ status: "pending" }) // only pending riders
            .toArray();
          res.json(pendingRiders);
        } catch (error) {
          console.error(error);
          res.status(500).json({ error: "Failed to fetch pending riders" });
        }
      }
    );
    app.patch("/api/parcels/:id/cashout", async (req, res) => {
      try {
        const { id } = req.params;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel)
          return res.status(404).json({ message: "Parcel not found" });

        if (parcel.delivery_status !== "delivered") {
          return res.status(400).json({ message: "Parcel not delivered yet" });
        }

        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { cashout_status: "cashed_out", cashed_at: new Date() } }
        );

        res.json({ message: "Cashout successful" });
      } catch (error) {
        console.error("Error cashing out parcel:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch("/api/rider/:email/cashout-all", async (req, res) => {
      try {
        const { email } = req.params;

        const result = await parcelsCollection.updateMany(
          {
            riderEmail: email,
            delivery_status: "delivered",
            $or: [
              { cashout_status: { $exists: false } },
              { cashout_status: "not_cashed" },
            ],
          },
          { $set: { cashout_status: "cashed_out", cashed_at: new Date() } }
        );

        res.json({
          message: `Cashout completed for ${result.modifiedCount} parcels.`,
        });
      } catch (error) {
        console.error("Error cashing out all parcels:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // update rider status active or rejected
    // PATCH /api/parcels/:id/assign-rider

    //update rider

    // Get all pending (rejected) riders
    app.get("/riders/rejected", async (req, res) => {
      try {
        const rejectedRiders = await ridersCollection
          .find({ status: "rejected" })
          .toArray();
        res.json(rejectedRiders);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch rejected riders" });
      }
    });

    // Get all approved (accepted) riders
    app.get(
      "/riders/approved",
      verifyFireBaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const approvedRiders = await ridersCollection
            .find({ status: "accepted" })
            .toArray();
          res.json(approvedRiders);
        } catch (error) {
          res.status(500).json({ error: "Failed to fetch approved riders" });
        }
      }
    );

    app.patch("/riders/:id", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body; // e.g., "deactivated" or "rejected"

      if (!status || !["accepted", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      try {
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        // update user role for accepting rider
        if (status == "accepted") {
          const useQuery = { email };
          const userUpdatedDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await userCollection.updateOne(
            useQuery,
            userUpdatedDoc
          );
          console.log(roleResult.modificationCount);
        }

        res.json({ message: `Rider ${status} successfully` });
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).json({ error: "Failed to update rider status" });
      }
    });

    // Add Parcel API
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;

        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send({ success: true, result });
      } catch (error) {
        console.log(error);
        res.status(500).send({ error: "Failed to create parcel" });
      }
    });

    // Get all parcels assigned to a rider by riderEmail
    app.get("/parcels/rider", async (req, res) => {
      try {
        const { riderEmail } = req.query; // ✅ read from query string ?riderEmail=

        if (!riderEmail) {
          return res.status(400).json({ message: "riderEmail is required" });
        }

        // PATCH: Update parcel delivery_status
        // PATCH: Toggle delivery status and set timestamps
        app.patch("/parcels/:id/toggle-delivery", async (req, res) => {
          try {
            const { id } = req.params;
            const parcel = await parcelsCollection.findOne({
              _id: new ObjectId(id),
            });

            if (!parcel) {
              return res.status(404).json({ message: "Parcel not found" });
            }

            let newStatus =
              parcel.delivery_status === "delivered"
                ? "in-transit"
                : "delivered";
            let updateFields = { delivery_status: newStatus };

            // Add timestamps
            if (newStatus === "in-transit") {
              updateFields.picked_at = new Date().toISOString();
            } else if (newStatus === "delivered") {
              updateFields.delivered_at = new Date().toISOString();
            }

            await parcelsCollection.updateOne(
              { _id: new ObjectId(id) },
              { $set: updateFields }
            );

            res.json({
              success: true,
              message: `Parcel marked as ${newStatus}`,
              newStatus,
              timestamps: updateFields,
            });
          } catch (error) {
            console.error("Error toggling delivery:", error);
            res.status(500).json({ message: "Server error" });
          }
        });

        // Find parcels where assigned_rider = true and riderEmail matches
        const parcels = await parcelsCollection
          .find({ assigned_rider: true, riderEmail: riderEmail })
          .toArray();

        res.json({ success: true, parcels });
      } catch (error) {
        console.error("Error fetching rider parcels:", error);
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const result = await parcelsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res.send(result);
        } else {
          res.status(404).json({ message: "Parcel not found" });
        }
      } catch (error) {
        console.error("❌ Error deleting parcel:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // GET Parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const parcel = await parcelsCollection.findOne(query);

        if (parcel) {
          res.status(200).json(parcel);
        } else {
          res.status(404).json({ message: "Parcel not found" });
        }
      } catch (error) {
        console.error("❌ Error fetching parcel:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCent, currency = "usd" } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCent, // cents
          currency,
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    app.post("/tracking", async (req, res) => {
      try {
        const { parcelId, status, location, updatedBy = "" } = req.body;
        if (!parcelId || !status) {
          return res
            .status(400)
            .json({ message: "parcelId and status are required" });
        }

        // (Optional) ensure parcel exists
        const parcelExists = await parcels.findOne({ tracking_id: parcelId });
        if (!parcelExists) {
          return res
            .status(404)
            .json({ message: "Parcel not found for given parcelId" });
        }

        const doc = {
          parcelId,
          status,
          location: location || "Unknown",
          updatedBy: updatedBy || "System",
          timestamp: new Date(),
        };

        const result = await tracking.insertOne(doc);

        // (Optional) keep a denormalized current status on parcel document
        await parcels.updateOne(
          { tracking_id: parcelId },
          { $set: { delivery_status: status, last_update: doc.timestamp } }
        );

        res.status(201).json({ insertedId: result.insertedId, update: doc });
      } catch (err) {
        console.error("❌ Error adding tracking:", err);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/payments", verifyFireBaseToken, async (req, res) => {
      //console.log("Header in Payment=", req.headers);
      try {
        const { email } = req.query; // read email from query ?email=example@gmail.com
        console.log("decoded=", req.decoded);

        if (email) {
          filter = { userEmail: email }; // match field in your DB
        }

        const payments = await paymentCollection
          .find(filter)
          .sort({ paid_at: -1 })
          .toArray();

        res.json(payments);
      } catch (err) {
        console.error("Error fetching payment history:", err);
        res.status(500).json({ message: "Failed to fetch payment history" });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, paymentIntentId, userEmail, amount } = req.body;

        if (!parcelId || !paymentIntentId || !userEmail || !amount) {
          return res.status(400).json({ message: "Missing required fields" });
        }

        // Update parcel
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).json({ message: "Parcel not found" });
        }

        // Insert payment record
        const paymentDoc = {
          parcelId: new ObjectId(parcelId),
          paymentIntentId,
          userEmail,
          amount,
          status: "success",
          createdAt: new Date(),
        };

        await paymentCollection.insertOne(paymentDoc);

        res.json({
          message: "Payment recorded successfully",
          payment: paymentDoc,
        });
      } catch (err) {
        console.error("Error in /payments route:", err);
        res
          .status(500)
          .json({ message: "Internal Server Error", error: err.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
