"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifySignatureAndParseRawBody = exports.respondToUrlVerification = exports.respondToSslCheck = void 0;
const http_1 = require("http");
const express_1 = __importStar(require("express"));
const raw_body_1 = __importDefault(require("raw-body"));
const querystring_1 = __importDefault(require("querystring"));
const crypto_1 = __importDefault(require("crypto"));
const tsscmp_1 = __importDefault(require("tsscmp"));
const errors_1 = require("./errors");
const logger_1 = require("@slack/logger");
const oauth_1 = require("@slack/oauth");
/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
class ExpressReceiver {
    constructor({ signingSecret = '', logger = new logger_1.ConsoleLogger(), endpoints = { events: '/slack/events' }, processBeforeResponse = false, clientId = undefined, clientSecret = undefined, stateSecret = undefined, installationStore = undefined, scopes = undefined, installerOptions = {}, app = undefined }) {
        this.installer = undefined;
        this.app = app !== null && app !== void 0 ? app : express_1.default();
        if (!app) {
            this.server = http_1.createServer(this.app);
        }
        const expressMiddleware = [
            verifySignatureAndParseRawBody(logger, signingSecret),
            exports.respondToSslCheck,
            exports.respondToUrlVerification,
            this.requestHandler.bind(this),
        ];
        this.processBeforeResponse = processBeforeResponse;
        this.logger = logger;
        const endpointList = typeof endpoints === 'string' ? [endpoints] : Object.values(endpoints);
        this.router = express_1.Router();
        for (const endpoint of endpointList) {
            this.router.post(endpoint, ...expressMiddleware);
        }
        if (clientId !== undefined
            && clientSecret !== undefined
            && (stateSecret !== undefined || installerOptions.stateStore !== undefined)) {
            this.installer = new oauth_1.InstallProvider({
                clientId,
                clientSecret,
                stateSecret,
                installationStore,
                stateStore: installerOptions.stateStore,
                authVersion: installerOptions.authVersion,
            });
        }
        // Add OAuth routes to receiver
        if (this.installer !== undefined) {
            const redirectUriPath = installerOptions.redirectUriPath === undefined ?
                '/slack/oauth_redirect' : installerOptions.redirectUriPath;
            this.router.use(redirectUriPath, async (req, res) => {
                await this.installer.handleCallback(req, res, installerOptions.callbackOptions);
            });
            const installPath = installerOptions.installPath === undefined ?
                '/slack/install' : installerOptions.installPath;
            this.router.get(installPath, async (_req, res, next) => {
                try {
                    const url = await this.installer.generateInstallUrl({
                        metadata: installerOptions.metadata,
                        scopes: scopes,
                    });
                    res.send(`<a href=${url}><img alt=""Add to Slack"" height="40" width="139"
              src="https://platform.slack-edge.com/img/add_to_slack.png"
              srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,
              https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>`);
                }
                catch (error) {
                    next(error);
                }
            });
        }
        this.app.use(this.router);
    }
    async requestHandler(req, res) {
        var _a;
        let isAcknowledged = false;
        setTimeout(() => {
            if (!isAcknowledged) {
                this.logger.error('An incoming event was not acknowledged within 3 seconds. ' +
                    'Ensure that the ack() argument is called in a listener.');
            }
            // tslint:disable-next-line: align
        }, 3001);
        let storedResponse = undefined;
        const event = {
            body: req.body,
            ack: async (response) => {
                this.logger.debug('ack() begin');
                if (isAcknowledged) {
                    throw new errors_1.ReceiverMultipleAckError();
                }
                isAcknowledged = true;
                if (this.processBeforeResponse) {
                    if (!response) {
                        storedResponse = '';
                    }
                    else {
                        storedResponse = response;
                    }
                    this.logger.debug('ack() response stored');
                }
                else {
                    if (!response) {
                        res.send('');
                    }
                    else if (typeof response === 'string') {
                        res.send(response);
                    }
                    else {
                        res.json(response);
                    }
                    this.logger.debug('ack() response sent');
                }
            },
        };
        try {
            await ((_a = this.bolt) === null || _a === void 0 ? void 0 : _a.processEvent(event, req, res));
            if (storedResponse !== undefined) {
                if (typeof storedResponse === 'string') {
                    res.send(storedResponse);
                }
                else {
                    res.json(storedResponse);
                }
                this.logger.debug('stored response sent');
            }
        }
        catch (err) {
            res.status(500).send();
            throw err;
        }
    }
    init(bolt) {
        this.bolt = bolt;
    }
    // TODO: the arguments should be defined as the arguments of Server#listen()
    // TODO: the return value should be defined as a type that both http and https servers inherit from, or a union
    start(port) {
        return new Promise((resolve, reject) => {
            try {
                // TODO: what about other listener options?
                // TODO: what about asynchronous errors? should we attach a handler for this.server.on('error', ...)?
                // if so, how can we check for only errors related to listening, as opposed to later errors?
                if (this.server) {
                    this.server.listen(port, () => {
                        resolve(this.server);
                    });
                }
                else {
                    resolve();
                }
            }
            catch (error) {
                reject(error);
            }
        });
    }
    // TODO: the arguments should be defined as the arguments to close() (which happen to be none), but for sake of
    // generic types
    stop() {
        return new Promise((resolve, reject) => {
            // TODO: what about synchronous errors?
            if (this.server) {
                this.server.close((error) => {
                    if (error !== undefined) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
}
exports.default = ExpressReceiver;
exports.respondToSslCheck = (req, res, next) => {
    if (req.body && req.body.ssl_check) {
        res.send();
        return;
    }
    next();
};
exports.respondToUrlVerification = (req, res, next) => {
    if (req.body && req.body.type && req.body.type === 'url_verification') {
        res.json({ challenge: req.body.challenge });
        return;
    }
    next();
};
/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
function verifySignatureAndParseRawBody(logger, signingSecret) {
    return async (req, res, next) => {
        let stringBody;
        // On some environments like GCP (Google Cloud Platform),
        // req.body can be pre-parsed and be passed as req.rawBody here
        const preparsedRawBody = req.rawBody;
        if (preparsedRawBody !== undefined) {
            stringBody = preparsedRawBody.toString();
        }
        else {
            stringBody = (await raw_body_1.default(req)).toString();
        }
        // *** Parsing body ***
        // As the verification passed, parse the body as an object and assign it to req.body
        // Following middlewares can expect `req.body` is already a parsed one.
        try {
            // This handler parses `req.body` or `req.rawBody`(on Google Could Platform)
            // and overwrites `req.body` with the parsed JS object.
            req.body = verifySignatureAndParseBody(signingSecret, stringBody, req.headers);
        }
        catch (error) {
            if (error) {
                if (error instanceof errors_1.ReceiverAuthenticityError) {
                    logError(logger, 'Request verification failed', error);
                    return res.status(401).send();
                }
                logError(logger, 'Parsing request body failed', error);
                return res.status(400).send();
            }
        }
        return next();
    };
}
exports.verifySignatureAndParseRawBody = verifySignatureAndParseRawBody;
function logError(logger, message, error) {
    const logMessage = ('code' in error)
        ? `${message} (code: ${error.code}, message: ${error.message})`
        : `${message} (error: ${error})`;
    logger.warn(logMessage);
}
function verifyRequestSignature(signingSecret, body, signature, requestTimestamp) {
    if (signature === undefined || requestTimestamp === undefined) {
        throw new errors_1.ReceiverAuthenticityError('Slack request signing verification failed. Some headers are missing.');
    }
    const ts = Number(requestTimestamp);
    if (isNaN(ts)) {
        throw new errors_1.ReceiverAuthenticityError('Slack request signing verification failed. Timestamp is invalid.');
    }
    // Divide current date to match Slack ts format
    // Subtract 5 minutes from current time
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
    if (ts < fiveMinutesAgo) {
        throw new errors_1.ReceiverAuthenticityError('Slack request signing verification failed. Timestamp is too old.');
    }
    const hmac = crypto_1.default.createHmac('sha256', signingSecret);
    const [version, hash] = signature.split('=');
    hmac.update(`${version}:${ts}:${body}`);
    if (!tsscmp_1.default(hash, hmac.digest('hex'))) {
        throw new errors_1.ReceiverAuthenticityError('Slack request signing verification failed. Signature mismatch.');
    }
}
/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
function verifySignatureAndParseBody(signingSecret, body, headers) {
    // *** Request verification ***
    const { 'x-slack-signature': signature, 'x-slack-request-timestamp': requestTimestamp, 'content-type': contentType, } = headers;
    verifyRequestSignature(signingSecret, body, signature, requestTimestamp);
    return parseRequestBody(body, contentType);
}
function parseRequestBody(stringBody, contentType) {
    if (contentType === 'application/x-www-form-urlencoded') {
        const parsedBody = querystring_1.default.parse(stringBody);
        if (typeof parsedBody.payload === 'string') {
            return JSON.parse(parsedBody.payload);
        }
        return parsedBody;
    }
    return JSON.parse(stringBody);
}
//# sourceMappingURL=ExpressReceiver.js.map