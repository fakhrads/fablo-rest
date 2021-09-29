import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import bearerToken from "express-bearer-token";
import FabricCAServices from "fabric-ca-client";
import matches from "ts-matches";
import NetworkPool from "./NetworkPool";
import IdentityCache from "./IdentityCache";
import config from "./config";
import Authorization from "./Authorization";
import ChaincodeRequest from "./ChaincodeRequest";
import { Utils } from "fabric-common";

const logger = Utils.getLogger("FabloRest");

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(bearerToken());

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  logger.debug(`${req.method} ${req.path}`);
  next();
});

const ca = new FabricCAServices(config.FABRIC_CA_URL, undefined, config.FABRIC_CA_NAME);

app.post("/user/enroll", async (req, res) => {
  const id: string = req.body.id;
  const secret: string = req.body.secret;
  console.log("Enrolling as", id);

  try {
    const enrollResp = await ca.enroll({ enrollmentID: id, enrollmentSecret: secret });
    const token = await IdentityCache.put(id, enrollResp.key, enrollResp.certificate, config.MSP_ID);
    res.status(200).send({ token });
  } catch (e) {
    res.status(400).send({ message: e.message });
  }
});

app.post("/user/reenroll", async (req, res) => {
  const caller = await Authorization.getFromToken(req, res);
  const id = caller.user.getName();
  console.log("Re enrolling user", id);

  try {
    const enrollResp = await ca.reenroll(caller.user, []);
    const token = await IdentityCache.put(id, enrollResp.key, enrollResp.certificate, config.MSP_ID);
    IdentityCache.del(caller.token);
    res.status(200).send({ token });
  } catch (e) {
    res.status(400).send({ message: e.message });
  }
});

app.post("/user/register", async (req, res) => {
  const caller = await Authorization.getFromToken(req, res);

  const id = req.body.id;
  const secret = req.body.secret;
  console.log("Registering", id, "by", caller.user.getName());

  const registerRequest = {
    enrollmentID: id,
    enrollmentSecret: secret,
    affiliation: config.AFFILIATION,
    maxEnrollments: 0,
  };

  try {
    await ca.register(registerRequest, caller.user);
    return res.status(201).send({ message: "ok" });
  } catch (e) {
    return res.status(400).send({ message: e.message });
  }
});

app.get("/user/identities", async (req, res) => {
  const caller = await Authorization.getFromToken(req, res);
  console.log("Retrieving user list for user", caller.user.getName());

  try {
    const response = await ca.newIdentityService().getAll(caller.user);
    if (response.result) {
      return res.status(200).send({ response: response.result });
    } else {
      return res.status(400).send({ ...response, message: "Cannot get identities" });
    }
  } catch (e) {
    return res.status(400).send({ message: e.message });
  }
});

const payloadWithStatusShape = matches.shape({ status: matches.natural, payload: matches.any });

const TransactionResult = {
  parse: (b: Buffer): { status: number; response: any } => {
    try {
      const payload: Record<string, any> = JSON.parse(b.toString());
      if (payloadWithStatusShape.test(payload)) {
        return { status: payload.status, response: payload.payload };
      } else {
        return { status: 200, response: payload };
      }
    } catch (_e) {
      return { status: 200, response: b.toString() };
    }
  },
};

app.post("/discover/:channelName", async (req, res) => {
  const identity = await Authorization.getFromToken(req, res);
  try {
    const response = await NetworkPool.discover(identity.user, req.params.channelName);
    res.status(200).send({ response });
  } catch (e) {
    res.status(500).send({ message: e.message });
  }
});

app.post("/invoke/:channelName/:chaincodeName", async (req, res) => {
  const identity = await Authorization.getFromToken(req, res);
  const chaincodeReq = ChaincodeRequest.getValid(req, res);
  const network = await NetworkPool.connect(identity, chaincodeReq.channelName);
  console.log("Invoking chaincode", chaincodeReq.method, "by", identity.user.getName());

  try {
    const transactionResult = await network
      .getContract(chaincodeReq.chaincodeName)
      .createTransaction(chaincodeReq.method)
      .setTransient(chaincodeReq.transient)
      .submit(...chaincodeReq.args);

    const { status, response } = TransactionResult.parse(transactionResult);
    res.status(status).send({ response });
  } catch (e) {
    res.status(400).send({ message: e.transactionCode ?? e.message });
  }
});

app.post("/query/:channelName/:chaincodeName", async (req, res) => {
  const identity = await Authorization.getFromToken(req, res);
  const chaincodeReq = ChaincodeRequest.getValid(req, res);
  const network = await NetworkPool.connect(identity, chaincodeReq.channelName);
  logger.debug("Querying chaincode", chaincodeReq.method, "by", identity.user.getName());

  try {
    const transactionResult = await network
      .getContract(chaincodeReq.chaincodeName)
      .createTransaction(chaincodeReq.method)
      .setTransient(chaincodeReq.transient)
      .evaluate(...chaincodeReq.args);

    const { status, response } = TransactionResult.parse(transactionResult);
    res.status(status).send({ response });
  } catch (e) {
    res.status(400).send({ message: e.transactionCode ?? e.message });
  }
});

app.listen(config.PORT, () => {
  logger.info(`⚡️[server]: Server is running at https://localhost:${config.PORT} for organization ${config.MSP_ID}`);
});
