// backend/routes/api.js
//
// FIX 1: this file only registered device routes — auth.routes.js was never
// require'd or mounted here, so /api/auth/* all 404'd with Express's default
// HTML page (which your frontend was trying to JSON.parse()).
//
// FIX 2: auth.routes.js lives in this SAME routes/ folder. The previous
// version of this fix used `require("../routes/auth.routes")`, which looks
// for a nonexistent nested routes/routes/ folder and would have crashed the
// server on boot with "Cannot find module". Corrected to `./auth.routes`.

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