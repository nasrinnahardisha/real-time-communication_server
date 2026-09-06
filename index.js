require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

// HTTP & Socket.io Import
const http = require("http");
const { Server } = require("socket.io");

// Multer & Cloudinary Import
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

// Express-GraphQL Imports
const { graphqlHTTP } = require("express-graphql");
const {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
  GraphQLBoolean,
} = require("graphql");

const app = express();
const port = process.env.PORT || 5000;

// HTTP Server & Socket.io Config
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  },
});

// Socket.io Connection Logic
io.on("connection", (socket) => {
  console.log("⚡ A user connected:", socket.id);

  socket.on("join_room", (userId) => {
    socket.join(userId);
  });

  socket.on("send_message", (data) => {
    if (data.receiverId) {
      io.to(data.receiverId).emit("receive_message", data);
    } else {
      io.emit("receive_message", data);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
  });
});

// Multer Config
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Firebase Admin SDK Config
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);
initializeApp({
  credential: cert(serviceAccount),
});

// Middlewares
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  }),
);
app.use(express.json());

// Auth Middleware for Express & GraphQL context
const authenticate = async (req, res, next) => {
  const authorization = req.headers?.authorization;

  if (authorization && authorization.startsWith("Bearer ")) {
    try {
      const idToken = authorization.split(" ")[1];
      const decodedToken = await getAuth().verifyIdToken(idToken);
      req.currentUser = decodedToken;
    } catch (error) {
      req.currentUser = null;
    }
  } else {
    req.currentUser = null;
  }
  next();
};

app.use(authenticate);

// REST Auth Middleware
const verifyFBToken = (req, res, next) => {
  if (!req.currentUser) {
    return res
      .status(401)
      .send({ message: "unauthorized access - token missing or invalid" });
  }
  req.decoded_email = req.currentUser.email;
  next();
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.jdtyh.mongodb.net/?appName=Cluster0`;

// FIX 1: strict: true সরিয়ে ফেলা হয়েছে text index ক্র্যাশ বন্ধ করতে
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("productDB");
    const productsCollection = db.collection("products");
    const usersCollection = db.collection("users");

    // Try-Catch used for safely creating index without server crashing
    try {
      await productsCollection.createIndex({ name: "text", title: "text" });
    } catch (indexError) {
      console.log("Index creation note:", indexError.message);
    }

    // REST Verify Admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // Helper: Admin Check function for GraphQL Resolvers
    const checkAdminPermission = async (currentUser) => {
      if (!currentUser) throw new Error("Unauthorized - Access token missing");
      const user = await usersCollection.findOne({ email: currentUser.email });
      if (!user || user.role !== "admin") {
        throw new Error("Forbidden - Admin access required");
      }
      return user;
    };

    // ==========================================
    // GRAPHQL TYPES DEFINITION
    // ==========================================

    const UserType = new GraphQLObjectType({
      name: "User",
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        email: { type: GraphQLString },
        role: { type: GraphQLString },
        createdAt: { type: GraphQLString },
      }),
    });

    const ProductType = new GraphQLObjectType({
      name: "Product",
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        name: { type: GraphQLString },
        category: { type: GraphQLString },
        price: { type: GraphQLFloat },
        status: { type: GraphQLString },
        description: { type: GraphQLString },
        image: { type: GraphQLString },
        createdAt: { type: GraphQLString },
      }),
    });

    // ==========================================
    // GRAPHQL ROOT QUERY
    // ==========================================

    const RootQuery = new GraphQLObjectType({
      name: "RootQueryType",
      fields: {
        users: {
          type: new GraphQLList(UserType),
          args: { searchText: { type: GraphQLString } },
          async resolve(parent, args, req) {
            if (!req.currentUser) {
              throw new Error("Unauthorized access - Please login first");
            }
            const query = args.searchText
              ? { email: { $regex: args.searchText, $options: "i" } }
              : {};
            const users = await usersCollection.find(query).toArray();
            return users.map((u) => ({ ...u, id: u._id.toString() }));
          },
        },

        getUserRole: {
          type: GraphQLString,
          args: { email: { type: new GraphQLNonNull(GraphQLString) } },
          async resolve(parent, args, req) {
            if (!req.currentUser) throw new Error("Unauthorized access");
            const formattedEmail = decodeURIComponent(args.email)
              .trim()
              .toLowerCase();
            const user = await usersCollection.findOne({
              email: { $regex: new RegExp(`^${formattedEmail}$`, "i") },
            });
            return user?.role || "user";
          },
        },

        products: {
          type: new GraphQLList(ProductType),
          args: { search: { type: GraphQLString } },
          async resolve(parent, args) {
            let query = {};
            if (args.search) {
              query = { name: { $regex: args.search, $options: "i" } };
            }
            const products = await productsCollection
              .find(query)
              .sort({ createdAt: -1 })
              .toArray();
            return products.map((p) => ({ ...p, id: p._id.toString() }));
          },
        },

        product: {
          type: ProductType,
          args: { id: { type: new GraphQLNonNull(GraphQLID) } },
          async resolve(parent, args) {
            if (!ObjectId.isValid(args.id))
              throw new Error("Invalid Product ID format");
            const product = await productsCollection.findOne({
              _id: new ObjectId(args.id),
            });
            if (!product) throw new Error("Product not found");
            return { ...product, id: product._id.toString() };
          },
        },
      },
    });

    // ==========================================
    // GRAPHQL MUTATIONS
    // ==========================================

    const Mutation = new GraphQLObjectType({
      name: "Mutation",
      fields: {
        addUser: {
          type: UserType,
          args: {
            displayName: { type: GraphQLString },
            email: { type: new GraphQLNonNull(GraphQLString) },
            role: { type: GraphQLString },
          },
          async resolve(parent, args) {
            const existingUser = await usersCollection.findOne({
              email: args.email,
            });
            if (existingUser) {
              return { ...existingUser, id: existingUser._id.toString() };
            }

            const newUser = {
              name: args.displayName || "",
              email: args.email,
              role: args.role || "user",
              createdAt: new Date().toISOString(),
            };

            const result = await usersCollection.insertOne(newUser);
            return { ...newUser, id: result.insertedId.toString() };
          },
        },

        updateUserRole: {
          type: GraphQLBoolean,
          args: {
            id: { type: new GraphQLNonNull(GraphQLID) },
            role: { type: new GraphQLNonNull(GraphQLString) },
          },
          async resolve(parent, args, req) {
            await checkAdminPermission(req.currentUser);
            const result = await usersCollection.updateOne(
              { _id: new ObjectId(args.id) },
              { $set: { role: args.role } },
            );
            return result.modifiedCount > 0;
          },
        },

        addProduct: {
          type: ProductType,
          args: {
            title: { type: GraphQLString },
            name: { type: GraphQLString },
            category: { type: GraphQLString },
            price: { type: new GraphQLNonNull(GraphQLFloat) },
            status: { type: GraphQLString },
            description: { type: GraphQLString },
            image: { type: GraphQLString },
          },
          async resolve(parent, args, req) {
            await checkAdminPermission(req.currentUser);

            const newProduct = {
              title: args.title || args.name || "",
              name: args.name || args.title || "",
              category: args.category || "",
              price: parseFloat(args.price) || 0,
              status: args.status || "In Stock",
              description: args.description || "",
              image: args.image || "",
              createdAt: new Date().toISOString(),
            };

            const result = await productsCollection.insertOne(newProduct);
            const createdProduct = {
              ...newProduct,
              id: result.insertedId.toString(),
            };

            io.emit("product_added", {
              message: "A new product has been created!",
              product: createdProduct,
            });

            return createdProduct;
          },
        },

        updateProduct: {
          type: GraphQLBoolean,
          args: {
            id: { type: new GraphQLNonNull(GraphQLID) },
            title: { type: GraphQLString },
            name: { type: GraphQLString },
            category: { type: GraphQLString },
            price: { type: GraphQLFloat },
            status: { type: GraphQLString },
            description: { type: GraphQLString },
            image: { type: GraphQLString },
          },
          async resolve(parent, { id, ...updatedFields }, req) {
            await checkAdminPermission(req.currentUser);
            if (!ObjectId.isValid(id)) throw new Error("Invalid Product ID");

            const result = await productsCollection.updateOne(
              { _id: new ObjectId(id) },
              { $set: updatedFields },
            );

            io.emit("product_updated", { id, updatedFields });
            return result.modifiedCount > 0;
          },
        },

        deleteProduct: {
          type: GraphQLBoolean,
          args: { id: { type: new GraphQLNonNull(GraphQLID) } },
          async resolve(parent, { id }, req) {
            await checkAdminPermission(req.currentUser);
            if (!ObjectId.isValid(id)) throw new Error("Invalid Product ID");

            const result = await productsCollection.deleteOne({
              _id: new ObjectId(id),
            });
            io.emit("product_deleted", { id });
            return result.deletedCount > 0;
          },
        },
      },
    });

    const schema = new GraphQLSchema({
      query: RootQuery,
      mutation: Mutation,
    });

    app.use(
      "/graphql",
      graphqlHTTP((req) => ({
        schema,
        graphiql: true,
        context: req,
      })),
    );

    // ==========================================
    // EXISTING REST APIs (Frontend-এর জন্য আবশ্যক)
    // ==========================================

    app.post(
      "/upload-image",
      verifyFBToken,
      verifyAdmin,
      upload.single("image"),
      async (req, res) => {
        try {
          if (!req.file) {
            return res
              .status(400)
              .send({ success: false, message: "No image file provided" });
          }

          const b64 = Buffer.from(req.file.buffer).toString("base64");
          const dataURI = "data:" + req.file.mimetype + ";base64," + b64;

          const result = await cloudinary.uploader.upload(dataURI, {
            folder: "taskflow_products",
          });

          res.status(200).send({
            success: true,
            url: result.secure_url,
          });
        } catch (error) {
          console.error("Cloudinary Upload Error:", error);
          res.status(500).send({ success: false, message: error.message });
        }
      },
    );

    app.get("/users", verifyFBToken, async (req, res) => {
      try {
        const searchText = req.query.searchText || "";
        const query = searchText
          ? { email: { $regex: searchText, $options: "i" } }
          : {};
        const users = await usersCollection.find(query).toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Failed to get users" });
      }
    });

    // FIX 2: React Application-এর UseRole Component-এর জন্য এই API আবার যোগ করে দেয়া হয়েছে
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = decodeURIComponent(req.params.email).trim().toLowerCase();
      const user = await usersCollection.findOne({
        email: { $regex: new RegExp(`^${email}$`, "i") },
      });
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      const newUser = {
        name: user.displayName,
        email: user.email,
        role: user.role || "user",
        createdAt: new Date(),
      };

      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: { role } };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      },
    );

    app.get("/products", async (req, res) => {
      const { search } = req.query;
      let query = search ? { name: { $regex: search, $options: "i" } } : {};
      const products = await productsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(products);
    });

    app.post("/products", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { title, name, category, price, status, description, image } =
          req.body;

        const newProduct = {
          title: title || name || "",
          name: name || title || "",
          category: category || "",
          price: parseFloat(price) || 0,
          status: status || "In Stock",
          description: description || "",
          image: image || "",
          createdAt: new Date(),
        };

        const result = await productsCollection.insertOne(newProduct);
        io.emit("product_added", {
          message: "A new product has been created!",
          product: { ...newProduct, _id: result.insertedId },
        });

        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add product" });
      }
    });

    app.get(["/products/:id", "/product/:id"], async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Product ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const product = await productsCollection.findOne(query);
        if (!product) {
          return res.status(404).send({ message: "Product not found" });
        }
        res.send(product);
      } catch (error) {
        res.status(500).send({ message: "Server error fetching product" });
      }
    });

    app.put("/products/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            title: updatedData.title || updatedData.name || "",
            name: updatedData.name || updatedData.title || "",
            category: updatedData.category || "",
            price: parseFloat(updatedData.price) || 0,
            status: updatedData.status || "In Stock",
            description: updatedData.description || "",
            image: updatedData.image || updatedData.imageUrl || "",
          },
        };

        const result = await productsCollection.updateOne(filter, updatedDoc);
        io.emit("product_updated", { id, updatedData });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update product" });
      }
    });

    app.delete(
      "/products/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const query = { _id: new ObjectId(id) };
          const result = await productsCollection.deleteOne(query);
          io.emit("product_deleted", { id });
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to delete product" });
        }
      },
    );

    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. Connected to MongoDB!");
  } catch (error) {
    console.error("Database connection error:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("TaskFlow Server is Running");
});

server.listen(port, () => {
  console.log(`TaskFlow app listening on port ${port}`);
  console.log(
    `GraphiQL testing tool is active at http://localhost:${port}/graphql`,
  );
});
