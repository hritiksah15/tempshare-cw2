const ttlCleanup = require("../ttl-cleanup/index");

const mockDelete = jest.fn().mockResolvedValue({});
const mockExists = jest.fn().mockResolvedValue(true);
const mockBlobDelete = jest.fn().mockResolvedValue({});

const mockFetchAll = jest.fn();
const mockItemDelete = jest.fn().mockResolvedValue({});

jest.mock("@azure/cosmos", () => ({
  CosmosClient: jest.fn().mockImplementation(() => ({
    database: () => ({
      container: () => ({
        items: {
          query: () => ({ fetchAll: mockFetchAll }),
        },
        item: () => ({ delete: mockItemDelete }),
      }),
    }),
  })),
}));

const mockContainerClient = {
  getBlobClient: () => ({
    exists: mockExists,
    delete: mockBlobDelete,
  }),
};

jest.mock("@azure/storage-blob", () => ({
  BlobServiceClient: (() => {
    const ctor = jest.fn().mockImplementation(() => ({
      getContainerClient: () => mockContainerClient,
    }));
    ctor.fromConnectionString = jest.fn().mockReturnValue({
      getContainerClient: () => mockContainerClient,
    });
    return ctor;
  })(),
}));

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn(),
}));

jest.mock("applicationinsights", () => ({
  setup: jest.fn().mockReturnValue({
    setAutoCollectRequests: jest.fn().mockReturnValue({
      setAutoCollectPerformance: jest.fn().mockReturnValue({
        setAutoCollectExceptions: jest.fn().mockReturnValue({
          setAutoCollectDependencies: jest.fn().mockReturnValue({
            start: jest.fn(),
          }),
        }),
      }),
    }),
  }),
  defaultClient: null,
}));

const createContext = () => ({
  log: Object.assign(jest.fn(), {
    error: jest.fn(),
    warn: jest.fn(),
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.COSMOS_ENDPOINT = "https://test.documents.azure.com:443/";
  process.env.COSMOS_KEY = "dGVzdGtleQ==";
  process.env.STORAGE_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
  process.env.STORAGE_ACCOUNT_URL = "https://teststorage.blob.core.windows.net";
});

describe("TTL Cleanup Function", () => {
  test("deletes expired documents and their blobs", async () => {
    const expiredDoc = {
      id: "asset-001",
      ownerID: "user_demo_001",
      blobPath: "assets/asset-001",
      expiresAt: "2025-01-01T00:00:00Z",
      fileSizeBytes: 1024,
    };

    mockFetchAll.mockResolvedValue({
      resources: [expiredDoc],
      requestCharge: 3.5,
    });

    const context = createContext();
    const timer = { isPastDue: false };

    await ttlCleanup(context, timer);

    expect(mockExists).toHaveBeenCalled();
    expect(mockBlobDelete).toHaveBeenCalled();
    expect(mockItemDelete).toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted: 1")
    );
  });

  test("handles no expired documents gracefully", async () => {
    mockFetchAll.mockResolvedValue({
      resources: [],
      requestCharge: 1.0,
    });

    const context = createContext();
    const timer = { isPastDue: false };

    await ttlCleanup(context, timer);

    expect(mockBlobDelete).not.toHaveBeenCalled();
    expect(mockItemDelete).not.toHaveBeenCalled();
    expect(context.log).toHaveBeenCalledWith(
      expect.stringContaining("Deleted: 0")
    );
  });

  test("handles missing blob without failing", async () => {
    mockFetchAll.mockResolvedValue({
      resources: [{
        id: "asset-002",
        ownerID: "user_demo_001",
        blobPath: "assets/asset-002",
        expiresAt: "2025-01-01T00:00:00Z",
      }],
      requestCharge: 2.0,
    });
    mockExists.mockResolvedValue(false);

    const context = createContext();
    const timer = { isPastDue: false };

    await ttlCleanup(context, timer);

    expect(mockBlobDelete).not.toHaveBeenCalled();
    expect(mockItemDelete).toHaveBeenCalled();
  });

  test("logs warning when timer is past due", async () => {
    mockFetchAll.mockResolvedValue({ resources: [], requestCharge: 1.0 });

    const context = createContext();
    const timer = { isPastDue: true };

    await ttlCleanup(context, timer);

    expect(context.log).toHaveBeenCalledWith(
      expect.stringContaining("running late")
    );
  });

  test("continues processing when individual delete fails", async () => {
    mockFetchAll.mockResolvedValue({
      resources: [
        { id: "asset-fail", ownerID: "user1", blobPath: "assets/asset-fail", expiresAt: "2025-01-01T00:00:00Z" },
        { id: "asset-ok", ownerID: "user1", blobPath: "assets/asset-ok", expiresAt: "2025-01-01T00:00:00Z" },
      ],
      requestCharge: 4.0,
    });

    mockItemDelete
      .mockRejectedValueOnce(new Error("Cosmos conflict"))
      .mockResolvedValueOnce({});

    const context = createContext();
    const timer = { isPastDue: false };

    await ttlCleanup(context, timer);

    expect(context.log).toHaveBeenCalledWith(
      expect.stringContaining("Errors: 1")
    );
  });
});
