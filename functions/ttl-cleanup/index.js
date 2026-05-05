const { CosmosClient } = require("@azure/cosmos");
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const appInsights = require("applicationinsights");

// ── APP INSIGHTS SETUP ──────────────────────────────────────────────────────
if (process.env.APPINSIGHTS_INSTRUMENTATIONKEY || process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  appInsights.setup()
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .start();
}
const telemetryClient = appInsights.defaultClient;

// ── CONFIG ───────────────────────────────────────────────────────────────────
const COSMOS_ENDPOINT     = process.env.COSMOS_ENDPOINT;
const COSMOS_DB_NAME      = process.env.COSMOS_DB_NAME      || "tempsharedb";
const COSMOS_CONTAINER    = process.env.COSMOS_CONTAINER    || "assets";
const STORAGE_ACCOUNT_URL = process.env.STORAGE_ACCOUNT_URL;
const BLOB_CONTAINER      = process.env.BLOB_CONTAINER      || "assets";

// ── MAIN FUNCTION ────────────────────────────────────────────────────────────
module.exports = async function (context, myTimer) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const correlationId = `ttl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  context.log(`[TTL-Cleanup] Timer fired at: ${timestamp} | correlationId: ${correlationId}`);

  if (myTimer.isPastDue) {
    context.log("[TTL-Cleanup] WARNING: Timer is running late!");
    trackEvent("TTLCleanupLateTrigger", { correlationId, timestamp });
  }

  let deletedCount = 0;
  let errorCount   = 0;
  let blobsDeleted = 0;
  let bytesFreed   = 0;

  try {
   // NEW - uses connection key (works with student subscription)
    const cosmosClient = new CosmosClient({
      endpoint: COSMOS_ENDPOINT,
      key: process.env.COSMOS_KEY || undefined,
      aadCredentials: process.env.COSMOS_KEY ? undefined : credential,
    });

    const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
    const containerClient   = blobServiceClient.getContainerClient(BLOB_CONTAINER);

    const database  = cosmosClient.database(COSMOS_DB_NAME);
    const container = database.container(COSMOS_CONTAINER);

    const now = new Date().toISOString();
    const querySpec = {
      query: "SELECT c.id, c.ownerID, c.blobPath, c.expiresAt, c.fileSizeBytes FROM c WHERE c.expiresAt < @now",
      parameters: [{ name: "@now", value: now }],
    };

    context.log(`[TTL-Cleanup] Querying expired assets (before ${now})`);

    const { resources: expiredDocs, requestCharge } = await container.items
      .query(querySpec, { partitionKey: undefined, enableCrossPartitionQuery: true })
      .fetchAll();

    context.log(`[TTL-Cleanup] Found ${expiredDocs.length} expired documents (${requestCharge} RUs)`);
    trackMetric("TTLCleanupQueryRUs", requestCharge, { correlationId });

    for (const doc of expiredDocs) {
      try {
        if (doc.blobPath) {
          const blobName = doc.blobPath.replace(/^assets\//, "");
          const blobClient = containerClient.getBlobClient(blobName);
          const exists = await blobClient.exists();
          if (exists) {
            await blobClient.delete();
            blobsDeleted++;
            if (doc.fileSizeBytes) bytesFreed += doc.fileSizeBytes;
            context.log(`[TTL-Cleanup] Deleted blob: ${blobName}`);
          } else {
            context.log(`[TTL-Cleanup] Blob already gone: ${blobName}`);
          }
        }

        const item = container.item(doc.id, doc.ownerID);
        await item.delete();
        context.log(`[TTL-Cleanup] Deleted Cosmos doc: ${doc.id}`);

        deletedCount++;

        trackEvent("TTLAssetExpired", {
          correlationId,
          assetId: doc.id,
          ownerID: doc.ownerID,
          expiresAt: doc.expiresAt,
        });

      } catch (itemErr) {
        context.log.error(`[TTL-Cleanup] Failed to delete ${doc.id}: ${itemErr.message}`);
        errorCount++;
        trackException(itemErr, { correlationId, assetId: doc.id });
      }
    }

    const duration = Date.now() - startTime;

    context.log(`[TTL-Cleanup] Complete. Deleted: ${deletedCount}, Blobs: ${blobsDeleted}, Errors: ${errorCount}, Duration: ${duration}ms`);

    trackEvent("TTLCleanupRun", {
      correlationId,
      deletedCount: String(deletedCount),
      blobsDeleted: String(blobsDeleted),
      errorCount: String(errorCount),
      bytesFreed: String(bytesFreed),
      expiredFound: String(expiredDocs.length),
      durationMs: String(duration),
    });

    trackMetric("TTLAssetsDeleted", deletedCount, { correlationId });
    trackMetric("TTLBlobBytesFreed", bytesFreed, { correlationId });
    trackMetric("TTLCleanupDuration", duration, { correlationId });

  } catch (err) {
    context.log.error(`[TTL-Cleanup] Fatal error: ${err.message}`);
    context.log.error(err.stack);
    trackException(err, { correlationId, phase: "main" });
    throw err;
  }
};

// ── TELEMETRY HELPERS ────────────────────────────────────────────────────────
function trackEvent(name, properties) {
  if (telemetryClient) {
    telemetryClient.trackEvent({ name, properties });
  }
}

function trackMetric(name, value, properties) {
  if (telemetryClient) {
    telemetryClient.trackMetric({ name, value, properties });
  }
}

function trackException(error, properties) {
  if (telemetryClient) {
    telemetryClient.trackException({ exception: error, properties });
  }
}
