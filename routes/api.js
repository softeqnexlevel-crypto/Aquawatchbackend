
const express = require("express");
const ctrl = require("../controllers/deviceController");
const authRoutes = require("./auth.routes"); // FIXED: sibling file, not ../routes/

const router = express.Router();

router.use("/auth", authRoutes); // reachable at /api/auth/*

router.get("/current", ctrl.current);
router.get("/status", ctrl.status);
router.get("/alarms", ctrl.alarms);
router.get("/mqtt-status", ctrl.mqttStatus); // New endpoint
router.post("/publish", ctrl.publish);

module.exports = router;