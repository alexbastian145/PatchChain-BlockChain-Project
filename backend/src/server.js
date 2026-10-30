require("dotenv").config();
const express = require("express");
const cors = require("cors");

const reportsRouter = require("./routes/reports");
const ipfsRouter = require("./routes/ipfs");
const queriesRouter = require("./routes/queries");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "patchchain-backend" });
});

app.use("/api/reports", reportsRouter);
app.use("/api/ipfs", ipfsRouter);
app.use("/api", queriesRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PatchChain backend listening on http://localhost:${PORT}`);
});
