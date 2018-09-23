// app/lightning.js
const grpc = require("grpc");
const fs = require("fs");
const logger = require("winston");
const debug = require("debug")("lncliweb:lightning");

const LightningError = Object.freeze({
    "WALLET_LOCKED": "WALLET_LOCKED",
    "NODE_UNREACHABLE": "NODE_UNREACHABLE",
    "UNCATEGORIZED": "UNCATEGORIZED"
});


/**
 * Defines a wrapper around the Lightning gRPC API, with error support, retry, and async API.
 * Every call towards `Lightning` should be handled through the `Call` API.
 */
class LightningManager {

    getActiveClient() {
        if (!this.activeClient) {
            logger.info("Recreating active client");
            this.credentials = this.generateCredentials(this.lndCert, {macaroonPath: this.macaroonPath});
            this.activeClient = new this.lnrpcDescriptor.lnrpc.Lightning(this.lndHost, this.credentials);
        }
        return this.activeClient;
    }

    generateCredentials(lndCert, options) {
	let credentials = grpc.credentials.createSsl(lndCert);

        // If macaroon path was specified load credentials using macaroon metadata.
        if (options.macaroonPath) {
            if (fs.existsSync(options.macaroonPath)) {
                let macaroonCreds = grpc.credentials.createFromMetadataGenerator(function (args, callback) {
                    let adminMacaroon = fs.readFileSync(options.macaroonPath);
                    let metadata = new grpc.Metadata();
                    metadata.add("macaroon", adminMacaroon.toString("hex"));
                    callback(null, metadata);
                });
                credentials = grpc.credentials.combineChannelCredentials(credentials, macaroonCreds);
            } else {
                logger.error("The specified macaroon file "+ options.macaroonPath + " was not found.\n" + 
                             "Please add the missing lnd macaroon file or update/remove the path in the application configuration.");
                process.exit(1);
            }
        }

        return credentials;
    }

    /**
     * @constructor
     * @param {string} protoPath - the path to the `rpc.proto` file that defined the `Lightning` RPC interface
     * @param {string} lndHost - the host and port of the LND node (ex. "locahost:10003")
     * @param {string} lndCertPath - the path to the SSL certificate used by LND 
     * @param {?string} macaroonPath - the path to the macarron file to use. Can be `null` if no macaroon should be used.
     */
    constructor(protoPath, lndHost, lndCertPath, macaroonPath) {
        process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

	if (!fs.existsSync(lndCertPath)) {
            logger.error("Required lnd certificate path missing from application configuration.");
            process.exit(1);
        }

        // Define credentials for SSL certificate generated by LND, and active client
        this.lndHost = lndHost;
	this.lndCert = fs.readFileSync(lndCertPath);
        this.lnrpcDescriptor = grpc.load(protoPath);
	this.macaroonPath = macaroonPath;
        this.activeClient = null;
    }

    /*
     * Calls a Lightning gRPC method.
     * @param {string} method - the gRPC method to call (ex. "getInfo")
     * @param {Object} parameters - optional key/value parameters to supply for the API call
     * @returns {Promise} - if successful, response if an Object containing API result payload, otherwise it will fail
       with a LightningError.
     */
    async call(method, parameters) {
        return new Promise((resolve, reject) => {
            let activeClient = this.getActiveClient();
            activeClient[method](parameters, (err, response) => {
                if (err) {

                    // drop active client, so that it can be recreated
                    this.activeClient = null;

                    switch(err.code) {
                        case grpc.status.UNIMPLEMENTED:
                            reject(LightningError.WALLET_LOCKED);
                            break;
                        case grpc.status.UNAVAILABLE:
                            reject(LightningError.NODE_UNREACHABLE);
                            break;
                        default:
                            logger.error("Unrecognized gRPC error: " + err);
                            reject(LightningError.UNCATEGORIZED);
                    }
                } else {
                    logger.debug(method + ":", response);
                    resolve(response);
                }
            });
        });
    }
}


module.exports = LightningManager;
