/// <reference types="node" />
import { Receiver } from './types';
import { /*createServer,*/ Server } from 'http';
import { Application, RequestHandler, Router } from 'express';
import App from './App';
import { Logger } from '@slack/logger';
import { InstallProvider, StateStore, InstallationStore, CallbackOptions } from '@slack/oauth';
export interface ExpressReceiverOptions {
    signingSecret: string;
    logger?: Logger;
    endpoints?: string | {
        [endpointType: string]: string;
    };
    processBeforeResponse?: boolean;
    clientId?: string;
    clientSecret?: string;
    stateSecret?: string;
    installationStore?: InstallationStore;
    scopes?: string | string[];
    installerOptions?: InstallerOptions;
    app?: Application;
}
interface InstallerOptions {
    stateStore?: StateStore;
    authVersion?: 'v1' | 'v2';
    metadata?: string;
    installPath?: string;
    redirectUriPath?: string;
    callbackOptions?: CallbackOptions;
}
/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class ExpressReceiver implements Receiver {
    app: Application;
    private server?;
    private bolt;
    private logger;
    private processBeforeResponse;
    router: Router;
    installer: InstallProvider | undefined;
    constructor({ signingSecret, logger, endpoints, processBeforeResponse, clientId, clientSecret, stateSecret, installationStore, scopes, installerOptions, app }: ExpressReceiverOptions);
    private requestHandler;
    init(bolt: App): void;
    start(port: number): Promise<Server>;
    stop(): Promise<void>;
}
export declare const respondToSslCheck: RequestHandler;
export declare const respondToUrlVerification: RequestHandler;
/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
export declare function verifySignatureAndParseRawBody(logger: Logger, signingSecret: string): RequestHandler;
export {};
//# sourceMappingURL=ExpressReceiver.d.ts.map