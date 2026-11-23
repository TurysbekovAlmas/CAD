import express from "express";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TABLE_NAME = process.env.TABLE_NAME;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "default";
const EVENT_SOURCE = process.env.EVENT_SOURCE || "kbtu.shop.orders";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", env: process.env.ENV || "dev" });
});

app.get("/", (req, res) => {
  res.status(200).json({
    service: "orders-api-sis3",
    env: process.env.ENV || "dev",
    table: TABLE_NAME
  });
});

app.post("/orders", async (req, res) => {
  const { order_id, customer_id, total, force_fail } = req.body;
  if (!order_id || !customer_id) {
    return res.status(400).json({ error: "order_id and customer_id are required" });
  }

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CUSTOMER#${customer_id}`,
        SK: `ORDER#${order_id}`,
        Total: String(total || 0),
        Status: "CREATED",
        CreatedAt: new Date().toISOString()
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
    }));

    const ebResp = await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: EVENT_BUS_NAME,
        Source: EVENT_SOURCE,
        DetailType: "OrderPlaced",
        Detail: JSON.stringify({ order_id, customer_id, total: total || 0, force_fail: !!force_fail })
      }]
    }));

    if (ebResp.FailedEntryCount > 0) {
      throw new Error("Failed to publish domain event to EventBridge");
    }

    return res.status(201).json({ message: "Order created & event published", order_id });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return res.status(409).json({ error: "Duplicate order_id", order_id });
    }
    console.error("Order error:", err);
    return res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});