import { randomInt } from "crypto";
import { SHA256 } from "crypto-js";
import { v4 as uuidV4 } from "uuid";
import {
  checkValidLockEvidenceResponse,
  sendLockEvidenceRequest,
} from "../../../../main/typescript/gateway/client/lock-evidence";
import {
  OdapMessageType,
  PluginOdapGateway,
} from "../../../../main/typescript/gateway/plugin-odap-gateway";
import {
  LockEvidenceV1Response,
  SessionData,
} from "../../../../main/typescript/public-api";

const MAX_RETRIES = 5;
const MAX_TIMEOUT = 5000;

const LOCK_EVIDENCE_REQUEST_MESSAGE_HASH =
  "dummyLockEvidenceRequestMessageHash";

let sourceGatewayConstructor;
let recipientGatewayConstructor;
let pluginSourceGateway: PluginOdapGateway;
let pluginRecipientGateway: PluginOdapGateway;
let sequenceNumber: number;
let sessionID: string;
let step: number;

beforeEach(async () => {
  sourceGatewayConstructor = {
    name: "plugin-odap-gateway#sourceGateway",
    dltIDs: ["DLT2"],
    instanceId: uuidV4(),
  };
  recipientGatewayConstructor = {
    name: "plugin-odap-gateway#recipientGateway",
    dltIDs: ["DLT1"],
    instanceId: uuidV4(),
  };

  pluginSourceGateway = new PluginOdapGateway(sourceGatewayConstructor);
  pluginRecipientGateway = new PluginOdapGateway(recipientGatewayConstructor);

  if (
    pluginSourceGateway.database == undefined ||
    pluginRecipientGateway.database == undefined
  ) {
    throw new Error("Database is not correctly initialized");
  }

  await pluginSourceGateway.database.migrate.rollback();
  await pluginSourceGateway.database.migrate.latest();
  await pluginRecipientGateway.database.migrate.rollback();
  await pluginRecipientGateway.database.migrate.latest();

  sequenceNumber = randomInt(100);
  sessionID = uuidV4();
  step = 1;

  const sessionData: SessionData = {
    id: sessionID,
    step: step,
    sourceGatewayPubkey: pluginSourceGateway.pubKey,
    recipientGatewayPubkey: pluginRecipientGateway.pubKey,
    lockEvidenceRequestMessageHash: LOCK_EVIDENCE_REQUEST_MESSAGE_HASH,
    lastSequenceNumber: sequenceNumber,
    maxTimeout: 0,
    maxRetries: 0,
    rollbackProofs: [],
    sourceBasePath: "",
    recipientBasePath: "",
    rollbackActionsPerformed: [],
  };

  pluginSourceGateway.sessions.set(sessionID, sessionData);
});

test("valid lock evidence response", async () => {
  const lockEvidenceResponse: LockEvidenceV1Response = {
    messageType: OdapMessageType.LockEvidenceResponse,
    sessionID: sessionID,
    serverIdentityPubkey: pluginRecipientGateway.pubKey,
    clientIdentityPubkey: pluginSourceGateway.pubKey,
    hashLockEvidenceRequest: LOCK_EVIDENCE_REQUEST_MESSAGE_HASH,
    signature: "",
    sequenceNumber: sequenceNumber,
  };

  lockEvidenceResponse.signature = PluginOdapGateway.bufArray2HexStr(
    await pluginRecipientGateway.sign(JSON.stringify(lockEvidenceResponse)),
  );

  const messageHash = SHA256(JSON.stringify(lockEvidenceResponse)).toString();

  await checkValidLockEvidenceResponse(
    lockEvidenceResponse,
    pluginSourceGateway,
  );

  const retrievedSessionData = pluginSourceGateway.sessions.get(sessionID);

  if (retrievedSessionData == undefined) throw new Error("Test Failed.");

  expect(retrievedSessionData.id).toBe(sessionID);
  expect(retrievedSessionData.lockEvidenceResponseMessageHash).toBe(
    messageHash,
  );
  expect(retrievedSessionData.serverSignatureLockEvidenceResponseMessage).toBe(
    lockEvidenceResponse.signature,
  );
});

test("lock evidence response invalid because of wrong previous message hash", async () => {
  const lockEvidenceResponse: LockEvidenceV1Response = {
    messageType: OdapMessageType.LockEvidenceResponse,
    sessionID: sessionID,
    serverIdentityPubkey: pluginRecipientGateway.pubKey,
    clientIdentityPubkey: pluginSourceGateway.pubKey,
    hashLockEvidenceRequest: "wrongMessageHash",
    signature: "",
    sequenceNumber: sequenceNumber,
  };

  lockEvidenceResponse.signature = PluginOdapGateway.bufArray2HexStr(
    await pluginRecipientGateway.sign(JSON.stringify(lockEvidenceResponse)),
  );

  await checkValidLockEvidenceResponse(
    lockEvidenceResponse,
    pluginSourceGateway,
  )
    .then(() => {
      throw new Error("Test Failed");
    })
    .catch((ex: Error) =>
      expect(ex.message).toMatch(
        "previous message hash does not match the one that was sent",
      ),
    );
});

test("lock evidence response invalid because of wrong signature", async () => {
  const lockEvidenceResponse: LockEvidenceV1Response = {
    messageType: OdapMessageType.LockEvidenceResponse,
    sessionID: sessionID,
    serverIdentityPubkey: pluginRecipientGateway.pubKey,
    clientIdentityPubkey: pluginSourceGateway.pubKey,
    hashLockEvidenceRequest: LOCK_EVIDENCE_REQUEST_MESSAGE_HASH,
    signature: "",
    sequenceNumber: sequenceNumber,
  };

  lockEvidenceResponse.signature = PluginOdapGateway.bufArray2HexStr(
    await pluginRecipientGateway.sign("somethingWrong"),
  );

  await checkValidLockEvidenceResponse(
    lockEvidenceResponse,
    pluginSourceGateway,
  )
    .then(() => {
      throw new Error("Test Failed");
    })
    .catch((ex: Error) =>
      expect(ex.message).toMatch("message signature verification failed"),
    );
});

test("timeout in lock evidence request because no server gateway is connected", async () => {
  const sessionData: SessionData = {
    id: sessionID,
    step: 1,
    maxRetries: MAX_RETRIES,
    maxTimeout: MAX_TIMEOUT,
    sourceBasePath: "",
    recipientBasePath: "http://wrongpath",
    lastSequenceNumber: 77,
    sourceGatewayPubkey: pluginSourceGateway.pubKey,
    recipientGatewayPubkey: pluginRecipientGateway.pubKey,
    transferCommenceMessageResponseHash:
      "dummyTransferCommenceMessageResponseHash",
    lastMessageReceivedTimestamp: new Date().toString(),
    rollbackProofs: [],
    rollbackActionsPerformed: [],
  };

  pluginSourceGateway.sessions.set(sessionID, sessionData);

  await pluginSourceGateway.lockFabricAsset(sessionID);

  await sendLockEvidenceRequest(sessionID, pluginSourceGateway, true)
    .then(() => {
      throw new Error("Test Failed");
    })
    .catch((ex: Error) => {
      expect(ex.message).toMatch("Timeout exceeded.");
    });
});

afterEach(() => {
  pluginSourceGateway.database?.destroy();
  pluginRecipientGateway.database?.destroy();
});
