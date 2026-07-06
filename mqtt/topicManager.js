// backend/mqtt/topicManager.js
/**
 * Topics from an A-Box style gateway follow <ROOT>/<OrderName>,
 * e.g. R05/FEEDFlow — the last segment IS the parameter name.
 *
 * The gateway we're actually connected to (topic root like
 * "069107032F4002485") instead publishes two special sub-topics:
 *   <ROOT>/datalist    -> JSON config/manifest describing every tag
 *   <ROOT>/getboxdata  -> binary blob with all current readings packed together
 *
 * parameterFromTopic() still works fine for plain A-Box topics.
 * The two special topics are detected separately in plcParser.js
 * and handled by dedicated functions instead of being treated as
 * "a parameter called datalist" / "a parameter called getboxdata".
 */
const KNOWN_PARAMETERS = [
  "FEEDFlow", 
  "Permeateflow", 
  "ConcentrateFlow", 
  "ROPressure",
  "InterstagePress", 
  "ConcentratePress", 
  "Stage1Delta", 
  "Stage2Delta",
  "MediaFilterInPress", 
  "MediaFilterOutPress", 
  "SystemRecovery", 
  "PureWaterEC",
  "FeedTankLevel",
  "SystemOperation",
  "SystemMode",
  // ✅ ADD ANTISCALANT DOSER
  "AntiscalantDoser",
  "AntiscalantDosingActive",
  "DosingActive",
  "Doser",
];

const SPECIAL_TOPIC_SUFFIXES = {
  DATALIST: "datalist",
  GETBOXDATA: "getboxdata",
};

function parameterFromTopic(topic) {
  const parts = topic.split("/");
  return parts[parts.length - 1];
}

/**
 * Returns "datalist" | "getboxdata" | "standard" so the parser can
 * branch to the right handler instead of guessing from payload shape.
 */
function classifyTopic(topic) {
  const last = parameterFromTopic(topic);
  if (last === SPECIAL_TOPIC_SUFFIXES.DATALIST) return "datalist";
  if (last === SPECIAL_TOPIC_SUFFIXES.GETBOXDATA) return "getboxdata";
  return "standard";
}

module.exports = { 
  KNOWN_PARAMETERS, 
  parameterFromTopic, 
  classifyTopic, 
  SPECIAL_TOPIC_SUFFIXES 
};