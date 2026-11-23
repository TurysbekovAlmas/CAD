import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const envelope = JSON.parse(record.body);
      const order = envelope.detail ? envelope.detail : envelope;

      if (order.force_fail === true) {
        throw new Error(`Simulated processing failure for order ${order.order_id}`);
      }

      // Идемпотентное обновление по бизнес-ключу (order_id): сработает только один раз
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `CUSTOMER#${order.customer_id}`,
          SK: `ORDER#${order.order_id}`
        },
        UpdateExpression: "SET #st = :processed, ProcessedAt = :ts",
        ConditionExpression: "attribute_exists(PK) AND #st <> :processed",
        ExpressionAttributeNames: { "#st": "Status" },
        ExpressionAttributeValues: {
          ":processed": "ASYNC_PROCESSED",
          ":ts": new Date().toISOString()
        }
      }));

      console.log(`Processed order ${order.order_id}`);
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.warn(`Duplicate delivery ignored for message ${record.messageId}`);
        continue;
      }
      console.error(`Error processing ${record.messageId}:`, err.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};