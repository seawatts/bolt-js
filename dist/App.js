"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = __importDefault(require("util"));
const web_api_1 = require("@slack/web-api");
const logger_1 = require("@slack/logger");
const axios_1 = __importDefault(require("axios"));
const ExpressReceiver_1 = __importDefault(require("./ExpressReceiver"));
const builtin_1 = require("./middleware/builtin");
const process_1 = require("./middleware/process");
const conversation_store_1 = require("./conversation-store");
const helpers_1 = require("./helpers");
const errors_1 = require("./errors");
const allSettled = require("promise.allsettled"); // tslint:disable-line:no-require-imports import-name
const packageJson = require('../package.json'); // tslint:disable-line:no-require-imports no-var-requires
var logger_2 = require("@slack/logger");
Object.defineProperty(exports, "LogLevel", { enumerable: true, get: function () { return logger_2.LogLevel; } });
class WebClientPool {
    constructor() {
        this.pool = {};
    }
    getOrCreate(token, clientOptions) {
        const cachedClient = this.pool[token];
        if (typeof cachedClient !== 'undefined') {
            return cachedClient;
        }
        const client = new web_api_1.WebClient(token, clientOptions);
        this.pool[token] = client;
        return client;
    }
}
/**
 * A Slack App
 */
class App {
    constructor({ signingSecret = undefined, endpoints = undefined, agent = undefined, clientTls = undefined, receiver = undefined, convoStore = undefined, token = undefined, botId = undefined, botUserId = undefined, authorize = undefined, logger = undefined, logLevel = undefined, ignoreSelf = true, clientOptions = undefined, processBeforeResponse = false, clientId = undefined, clientSecret = undefined, stateSecret = undefined, installationStore = undefined, scopes = undefined, installerOptions = undefined, } = {}) {
        this.clients = {};
        if (typeof logger === 'undefined') {
            // Initialize with the default logger
            const consoleLogger = new logger_1.ConsoleLogger();
            consoleLogger.setName('bolt-app');
            this.logger = consoleLogger;
        }
        else {
            this.logger = logger;
        }
        if (typeof logLevel !== 'undefined' && this.logger.getLevel() !== logLevel) {
            this.logger.setLevel(logLevel);
        }
        this.errorHandler = defaultErrorHandler(this.logger);
        this.clientOptions = {
            agent,
            // App propagates only the log level to WebClient as WebClient has its own logger
            logLevel: this.logger.getLevel(),
            tls: clientTls,
            slackApiUrl: clientOptions !== undefined ? clientOptions.slackApiUrl : undefined,
        };
        // the public WebClient instance (app.client) - this one doesn't have a token
        this.client = new web_api_1.WebClient(undefined, this.clientOptions);
        this.axios = axios_1.default.create(Object.assign({
            httpAgent: agent,
            httpsAgent: agent,
        }, clientTls));
        this.middleware = [];
        this.listeners = [];
        // Check for required arguments of ExpressReceiver
        if (receiver !== undefined) {
            this.receiver = receiver;
        }
        else {
            // No custom receiver
            if (signingSecret === undefined) {
                throw new errors_1.AppInitializationError('Signing secret not found, so could not initialize the default receiver. Set a signing secret or use a ' +
                    'custom receiver.');
            }
            else {
                // Create default ExpressReceiver
                this.receiver = new ExpressReceiver_1.default({
                    signingSecret,
                    endpoints,
                    processBeforeResponse,
                    clientId,
                    clientSecret,
                    stateSecret,
                    installationStore,
                    installerOptions,
                    scopes,
                    logger: this.logger,
                });
            }
        }
        let usingOauth = false;
        if (this.receiver.installer !== undefined
            && this.receiver.installer.authorize !== undefined) {
            // This supports using the built in ExpressReceiver, declaring your own ExpressReceiver
            // and theoretically, doing a fully custom (non express) receiver that implements OAuth
            usingOauth = true;
        }
        if (token !== undefined) {
            if (authorize !== undefined || usingOauth) {
                throw new errors_1.AppInitializationError(`token as well as authorize options or oauth installer options were provided. ${tokenUsage}`);
            }
            this.authorize = singleTeamAuthorization(this.client, { botId, botUserId, botToken: token });
        }
        else if (authorize === undefined && !usingOauth) {
            throw new errors_1.AppInitializationError(`No token, no authorize options, and no oauth installer options provided. ${tokenUsage}`);
        }
        else if (authorize !== undefined && usingOauth) {
            throw new errors_1.AppInitializationError(`Both authorize options and oauth installer options provided. ${tokenUsage}`);
        }
        else if (authorize === undefined && usingOauth) {
            this.authorize = this.receiver.installer.authorize;
        }
        else if (authorize !== undefined && !usingOauth) {
            this.authorize = authorize;
        }
        else {
            this.logger.error('Never should have reached this point, please report to the team');
            helpers_1.assertNever();
        }
        // Conditionally use a global middleware that ignores events (including messages) that are sent from this app
        if (ignoreSelf) {
            this.use(builtin_1.ignoreSelf());
        }
        // Use conversation state global middleware
        if (convoStore !== false) {
            // Use the memory store by default, or another store if provided
            const store = convoStore === undefined ? new conversation_store_1.MemoryStore() : convoStore;
            this.use(conversation_store_1.conversationContext(store));
        }
        // Should be last to avoid exposing partially initialized app
        this.receiver.init(this);
    }
    /**
     * Register a new middleware, processed in the order registered.
     *
     * @param m global middleware function
     */
    use(m) {
        this.middleware.push(m);
        return this;
    }
    /**
     * Convenience method to call start on the receiver
     *
     * TODO: args could be defined using a generic constraint from the receiver type
     *
     * @param args receiver-specific start arguments
     */
    start(...args) {
        return this.receiver.start(...args);
    }
    stop(...args) {
        return this.receiver.stop(...args);
    }
    event(eventName, ...listeners) {
        this.listeners.push([builtin_1.onlyEvents, builtin_1.matchEventType(eventName), ...listeners]);
    }
    message(...patternsOrMiddleware) {
        const messageMiddleware = patternsOrMiddleware.map((patternOrMiddleware) => {
            if (typeof patternOrMiddleware === 'string' || util_1.default.types.isRegExp(patternOrMiddleware)) {
                return builtin_1.matchMessage(patternOrMiddleware);
            }
            return patternOrMiddleware;
        });
        this.listeners.push([builtin_1.onlyEvents, builtin_1.matchEventType('message'), ...messageMiddleware]);
    }
    shortcut(callbackIdOrConstraints, ...listeners) {
        const constraints = (typeof callbackIdOrConstraints === 'string' || util_1.default.types.isRegExp(callbackIdOrConstraints)) ?
            { callback_id: callbackIdOrConstraints } : callbackIdOrConstraints;
        // Fail early if the constraints contain invalid keys
        const unknownConstraintKeys = Object.keys(constraints)
            .filter(k => (k !== 'callback_id' && k !== 'type'));
        if (unknownConstraintKeys.length > 0) {
            this.logger.error(`Slack listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`);
            return;
        }
        this.listeners.push([builtin_1.onlyShortcuts, builtin_1.matchConstraints(constraints), ...listeners]);
    }
    action(actionIdOrConstraints, ...listeners) {
        // Normalize Constraints
        const constraints = (typeof actionIdOrConstraints === 'string' || util_1.default.types.isRegExp(actionIdOrConstraints)) ?
            { action_id: actionIdOrConstraints } : actionIdOrConstraints;
        // Fail early if the constraints contain invalid keys
        const unknownConstraintKeys = Object.keys(constraints)
            .filter(k => (k !== 'action_id' && k !== 'block_id' && k !== 'callback_id' && k !== 'type'));
        if (unknownConstraintKeys.length > 0) {
            this.logger.error(`Action listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`);
            return;
        }
        this.listeners.push([builtin_1.onlyActions, builtin_1.matchConstraints(constraints), ...listeners]);
    }
    // TODO: should command names also be regex?
    command(commandName, ...listeners) {
        this.listeners.push([builtin_1.onlyCommands, builtin_1.matchCommandName(commandName), ...listeners]);
    }
    options(actionIdOrConstraints, ...listeners) {
        const constraints = (typeof actionIdOrConstraints === 'string' || util_1.default.types.isRegExp(actionIdOrConstraints)) ?
            { action_id: actionIdOrConstraints } : actionIdOrConstraints;
        this.listeners.push([builtin_1.onlyOptions, builtin_1.matchConstraints(constraints), ...listeners]);
    }
    view(callbackIdOrConstraints, ...listeners) {
        const constraints = (typeof callbackIdOrConstraints === 'string' || util_1.default.types.isRegExp(callbackIdOrConstraints)) ?
            { callback_id: callbackIdOrConstraints, type: 'view_submission' } : callbackIdOrConstraints;
        // Fail early if the constraints contain invalid keys
        const unknownConstraintKeys = Object.keys(constraints)
            .filter(k => (k !== 'callback_id' && k !== 'type'));
        if (unknownConstraintKeys.length > 0) {
            this.logger.error(`View listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`);
            return;
        }
        if (constraints.type !== undefined && !validViewTypes.includes(constraints.type)) {
            this.logger.error(`View listener cannot be attached using unknown view event type: ${constraints.type}`);
            return;
        }
        this.listeners.push([builtin_1.onlyViewActions, builtin_1.matchConstraints(constraints), ...listeners]);
    }
    error(errorHandler) {
        this.errorHandler = errorHandler;
    }
    /**
     * Handles events from the receiver
     */
    async processEvent(event, req, res) {
        const { body, ack } = event;
        // TODO: when generating errors (such as in the say utility) it may become useful to capture the current context,
        // or even all of the args, as properties of the error. This would give error handling code some ability to deal
        // with "finally" type error situations.
        // Introspect the body to determine what type of incoming event is being handled, and any channel context
        const { type, conversationId } = helpers_1.getTypeAndConversation(body);
        // If the type could not be determined, warn and exit
        if (type === undefined) {
            this.logger.warn('Could not determine the type of an incoming event. No listeners will be called.');
            return;
        }
        // From this point on, we assume that body is not just a key-value map, but one of the types of bodies we expect
        const bodyArg = body;
        // Initialize context (shallow copy to enforce object identity separation)
        const source = buildSource(type, conversationId, bodyArg);
        let authorizeResult;
        try {
            authorizeResult = await this.authorize(source, bodyArg);
        }
        catch (error) {
            this.logger.warn('Authorization of incoming event did not succeed. No listeners will be called.');
            return this.handleError(error);
        }
        const context = { ...authorizeResult, req, res };
        // Factory for say() utility
        const createSay = (channelId) => {
            const token = selectToken(context);
            return (message) => {
                const postMessageArguments = (typeof message === 'string') ?
                    { token, text: message, channel: channelId } : { ...message, token, channel: channelId };
                return this.client.chat.postMessage(postMessageArguments);
            };
        };
        // Set body and payload (this value will eventually conform to AnyMiddlewareArgs)
        // NOTE: the following doesn't work because... distributive?
        // const listenerArgs: Partial<AnyMiddlewareArgs> = {
        const listenerArgs = {
            body: bodyArg,
            payload: (type === helpers_1.IncomingEventType.Event) ?
                bodyArg.event :
                (type === helpers_1.IncomingEventType.ViewAction) ?
                    bodyArg.view :
                    (type === helpers_1.IncomingEventType.Shortcut) ?
                        bodyArg :
                        (type === helpers_1.IncomingEventType.Action &&
                            isBlockActionOrInteractiveMessageBody(bodyArg)) ?
                            bodyArg.actions[0] :
                            bodyArg,
        };
        // Set aliases
        if (type === helpers_1.IncomingEventType.Event) {
            const eventListenerArgs = listenerArgs;
            eventListenerArgs.event = eventListenerArgs.payload;
            if (eventListenerArgs.event.type === 'message') {
                const messageEventListenerArgs = eventListenerArgs;
                messageEventListenerArgs.message = messageEventListenerArgs.payload;
            }
        }
        else if (type === helpers_1.IncomingEventType.Action) {
            const actionListenerArgs = listenerArgs;
            actionListenerArgs.action = actionListenerArgs.payload;
        }
        else if (type === helpers_1.IncomingEventType.Command) {
            const commandListenerArgs = listenerArgs;
            commandListenerArgs.command = commandListenerArgs.payload;
        }
        else if (type === helpers_1.IncomingEventType.Options) {
            const optionListenerArgs = listenerArgs;
            optionListenerArgs.options = optionListenerArgs.payload;
        }
        else if (type === helpers_1.IncomingEventType.ViewAction) {
            const viewListenerArgs = listenerArgs;
            viewListenerArgs.view = viewListenerArgs.payload;
        }
        else if (type === helpers_1.IncomingEventType.Shortcut) {
            const shortcutListenerArgs = listenerArgs;
            shortcutListenerArgs.shortcut = shortcutListenerArgs.payload;
        }
        // Set say() utility
        if (conversationId !== undefined && type !== helpers_1.IncomingEventType.Options) {
            listenerArgs.say = createSay(conversationId);
        }
        // Set respond() utility
        if (body.response_url) {
            listenerArgs.respond = (response) => {
                const validResponse = (typeof response === 'string') ? { text: response } : response;
                return this.axios.post(body.response_url, validResponse);
            };
        }
        // Set ack() utility
        if (type !== helpers_1.IncomingEventType.Event) {
            listenerArgs.ack = ack;
        }
        else {
            // Events API requests are acknowledged right away, since there's no data expected
            await ack();
        }
        // Get the client arg
        let client = this.client;
        const token = selectToken(context);
        if (token !== undefined) {
            let pool = this.clients[source.teamId];
            if (pool === undefined) {
                pool = this.clients[source.teamId] = new WebClientPool();
            }
            client = pool.getOrCreate(token, this.clientOptions);
        }
        // Dispatch event through the global middleware chain
        try {
            await process_1.processMiddleware(this.middleware, listenerArgs, context, client, this.logger, async () => {
                // Dispatch the event through the listener middleware chains and aggregate their results
                // TODO: change the name of this.middleware and this.listeners to help this make more sense
                const listenerResults = this.listeners.map(async (origListenerMiddleware) => {
                    // Copy the array so modifications don't affect the original
                    const listenerMiddleware = [...origListenerMiddleware];
                    // Don't process the last item in the listenerMiddleware array - it shouldn't get a next fn
                    const listener = listenerMiddleware.pop();
                    if (listener !== undefined) {
                        return process_1.processMiddleware(listenerMiddleware, listenerArgs, context, client, this.logger, async () => 
                        // When the listener middleware chain is done processing, call the listener without a next fn
                        listener({ ...listenerArgs, context, client, logger: this.logger }));
                    }
                });
                const settledListenerResults = await allSettled(listenerResults);
                const rejectedListenerResults = settledListenerResults.filter(lr => lr.status === 'rejected');
                if (rejectedListenerResults.length === 1) {
                    throw rejectedListenerResults[0].reason;
                }
                else if (rejectedListenerResults.length > 1) {
                    throw new errors_1.MultipleListenerError(rejectedListenerResults.map(rlr => rlr.reason));
                }
            });
        }
        catch (error) {
            return this.handleError(error);
        }
    }
    /**
     * Global error handler. The final destination for all errors (hopefully).
     */
    handleError(error) {
        return this.errorHandler(errors_1.asCodedError(error));
    }
}
exports.default = App;
const tokenUsage = 'Apps used in one workspace should be initialized with a token. Apps used in many workspaces ' +
    'should be initialized with oauth installer or authorize.';
const validViewTypes = ['view_closed', 'view_submission'];
/**
 * Helper which builds the data structure the authorize hook uses to provide tokens for the context.
 */
function buildSource(type, channelId, body) {
    // NOTE: potentially something that can be optimized, so that each of these conditions isn't evaluated more than once.
    // if this makes it prettier, great! but we should probably check perf before committing to any specific optimization.
    // tslint:disable:max-line-length
    const source = {
        teamId: ((type === helpers_1.IncomingEventType.Event || type === helpers_1.IncomingEventType.Command) ? body.team_id :
            (type === helpers_1.IncomingEventType.Action || type === helpers_1.IncomingEventType.Options || type === helpers_1.IncomingEventType.ViewAction || type === helpers_1.IncomingEventType.Shortcut) ? body.team.id :
                helpers_1.assertNever(type)),
        enterpriseId: ((type === helpers_1.IncomingEventType.Event || type === helpers_1.IncomingEventType.Command) ? body.enterprise_id :
            (type === helpers_1.IncomingEventType.Action || type === helpers_1.IncomingEventType.Options || type === helpers_1.IncomingEventType.ViewAction || type === helpers_1.IncomingEventType.Shortcut) ? body.team.enterprise_id :
                undefined),
        userId: ((type === helpers_1.IncomingEventType.Event) ?
            ((typeof body.event.user === 'string') ? body.event.user :
                (typeof body.event.user === 'object') ? body.event.user.id :
                    (body.event.channel !== undefined && body.event.channel.creator !== undefined) ? body.event.channel.creator :
                        (body.event.subteam !== undefined && body.event.subteam.created_by !== undefined) ? body.event.subteam.created_by :
                            undefined) :
            (type === helpers_1.IncomingEventType.Action || type === helpers_1.IncomingEventType.Options || type === helpers_1.IncomingEventType.ViewAction || type === helpers_1.IncomingEventType.Shortcut) ? body.user.id :
                (type === helpers_1.IncomingEventType.Command) ? body.user_id :
                    undefined),
        conversationId: channelId,
    };
    // tslint:enable:max-line-length
    return source;
}
function isBlockActionOrInteractiveMessageBody(body) {
    return body.actions !== undefined;
}
function defaultErrorHandler(logger) {
    return (error) => {
        logger.error(error);
        return Promise.reject(error);
    };
}
function singleTeamAuthorization(client, authorization) {
    // TODO: warn when something needed isn't found
    const identifiers = authorization.botUserId !== undefined &&
        authorization.botId !== undefined ?
        Promise.resolve({ botUserId: authorization.botUserId, botId: authorization.botId }) :
        client.auth.test({ token: authorization.botToken })
            .then((result) => {
            return {
                botUserId: result.user_id,
                botId: result.bot_id,
            };
        });
    return async () => {
        return Object.assign({ botToken: authorization.botToken }, await identifiers);
    };
}
function selectToken(context) {
    return context.botToken !== undefined ? context.botToken : context.userToken;
}
/* Instrumentation */
web_api_1.addAppMetadata({ name: packageJson.name, version: packageJson.version });
//# sourceMappingURL=App.js.map