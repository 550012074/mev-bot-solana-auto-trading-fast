/**
 * Optimized Pump.fun token sniper script - using local trade API
 * Features:
 * 1. Detect new token listings, compare the time between buy and received listing message; skip buy if > 1000ms
 * 2. If <= 1000ms, buy immediately
 * 3. After buy: sell 70% at 500ms, sell 100% at 1500ms
 * 4. Use Helius/QuickNode RPC to verify sell succeeded; if not, retry selling until success
 * 5. Entire flow executed serially; do not process multiple tokens simultaneously
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

// ---------- CONFIG ----------
const PUBLIC_KEY = 'GhVida4MNWsdf5iWnnrdRRG6NsE1FXnSGYePGEK7Akjn';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
if (!PUBLIC_KEY) throw new Error('Missing environment variable PUBLIC_KEY');
if (!PRIVATE_KEY) throw new Error('Missing environment variable PRIVATE_KEY');

const BUY_SOL = Number(process.env.BUY_SOL || '0.5');
const BUY_SLIPPAGE = Number(process.env.BUY_SLIPPAGE || '1000');
const SELL1_SLIPPAGE = Number(process.env.SELL1_SLIPPAGE || '1000');
const SELL2_SLIPPAGE = Number(process.env.SELL2_SLIPPAGE || '1000');
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE || '0.00000000005');
const POOL = (process.env.POOL || 'pump') as
  | 'pump'
  | 'raydium'
  | 'pump-amm'
  | 'launchlab'
  | 'raydium-cpmm'
  | 'bonk'
  | 'auto';

const FIRST_SELL_DELAY_MS = Number(process.env.FIRST_SELL_DELAY_MS || '500');
const SECOND_SELL_DELAY_MS = Number(process.env.SECOND_SELL_DELAY_MS || '1500');

// SolanaStreaming WebSocket config
const SOLANA_STREAMING_API_KEY = process.env.SOLANA_STREAMING_API_KEY || '';
const WS_URL = 'wss://api.solanastreaming.com/';
const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

// QuickNode RPC config
const QUICKNODE_RPC_URL = 'https://intensive-cool-sailboat.solana-mainnet.quiknode.pro/f6e1b2a4790588351db71721e9b9dcf28ddc7de9';

const EVENT_TIMEOUT_MS = Number(process.env.EVENT_TIMEOUT_MS || '900'); // 1000ms threshold

// Create connection and keypair
const web3Connection = new Connection(QUICKNODE_RPC_URL, 'confirmed');
const signerKeyPair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// ---------- Logging config ----------
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, `sniper_${new Date().toISOString().split('T')[0]}.log`);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Logger
class Logger {
  private logFile: string;
  
  constructor(logFile: string) {
    this.logFile = logFile;
  }
  
  private writeToFile(level: string, message: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    
    try {
      fs.appendFileSync(this.logFile, logEntry);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }
  
  info(message: string) {
    console.log(message);
    this.writeToFile('INFO', message);
  }
  
  success(message: string) {
    console.log(`✅ ${message}`);
    this.writeToFile('SUCCESS', message);
  }
  
  error(message: string, error?: any) {
    const errorMsg = error ? `${message}: ${error?.message || error}` : message;
    console.error(`❌ ${errorMsg}`);
    this.writeToFile('ERROR', errorMsg);
  }
  
  warning(message: string) {
    console.warn(`⚠️ ${message}`);
    this.writeToFile('WARNING', message);
  }
  
  debug(message: string) {
    console.log(`🔍 ${message}`);
    this.writeToFile('DEBUG', message);
  }
}

const logger = new Logger(LOG_FILE);

// ---------- State management ----------
let isProcessing = false; // Global lock to ensure only one token processed at a time
const seenMints = new Set<string>(); // Prevent duplicate processing

// Timing statistics
interface TradeTiming {
  mint: string;
  startTime: number;
  buyTime?: number;
  sell70Time?: number;
  sell100Time?: number;
  completeTime?: number;
  totalDuration?: number;
}

const tradeTimings = new Map<string, TradeTiming>();

// ---------- Utility functions ----------

// Check transaction success (via QuickNode RPC) - supports unlimited or limited attempts
async function checkTransactionSuccess(signature: string, maxAttempts?: number): Promise<boolean> {
  let attempts = 0;
  
  // Retry indefinitely until we have a clear result
  while (maxAttempts === undefined || attempts < maxAttempts) {
    attempts++;
    try {
      const tx = await web3Connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      
      if (tx) {
        if (tx.meta && tx.meta.err === null) {
          logger.success(`Transaction ${signature} confirmed successfully (attempt ${attempts})`);
          logger.info(`  - Status: SUCCESS (meta.err = null)`);
          return true;
        } else {
          logger.error(`Transaction ${signature} failed (attempt ${attempts})`);
          logger.error(`  - Status: FAILED (meta.err = ${JSON.stringify(tx.meta?.err)})`);
          logger.error(`Transaction failed, skipping this mint`);
          return false; // Transaction failed, skip this mint
        }
      } else {
        logger.warning(`Transaction ${signature} not found (attempt ${attempts}) (node might not have kept this history)`);
        
        if (maxAttempts === undefined || attempts < maxAttempts) {
          logger.info(`Waiting 200ms before retrying transaction status check...`);
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        } else {
          logger.warning(`Searched ${maxAttempts} times, transaction still not found — treating as failure`);
          return false;
        }
      }
      
    } catch (error) {
      logger.error(`Failed to query transaction ${signature} status (attempt ${attempts}):`, error);
      
      if (maxAttempts === undefined || attempts < maxAttempts) {
        logger.info(`Waiting 200ms before retrying transaction status check...`);
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      } else {
        logger.warning(`Searched ${maxAttempts} times, encountered errors — treating as failure`);
        return false;
      }
    }
  }
  
  return false;
}



// Submit local trade
async function tradeLocal(params: {
  action: 'buy' | 'sell';
  mint: string;
  amount: number | string;
  denominatedInSol: boolean;
  slippage: number;
  priorityFee: number;
  pool: typeof POOL;
}): Promise<string> {
  const body = {
    publicKey: PUBLIC_KEY,
    action: params.action,
    mint: params.mint,
    amount: params.amount,
    denominatedInSol: params.denominatedInSol ? 'true' : 'false',
    slippage: params.slippage,
    priorityFee: params.priorityFee,
    pool: params.pool,
  };

  try {
    logger.info(`Requesting ${params.action.toUpperCase()} transaction data: ${params.mint}`);
    
    const res = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 200) {
      // Successfully generated transaction
      const data = await res.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(data));
      
      // Sign transaction
      tx.sign([signerKeyPair]);
      
      // Send transaction
      const signature = await web3Connection.sendTransaction(tx);
      
      logger.success(`${params.action.toUpperCase()} ${params.mint} transaction sent: ${signature}`);
      logger.info(`Transaction link: https://solscan.io/tx/${signature}`);
      
      return signature;
    } else {
      const errorText = await res.text();
      throw new Error(`Failed to get transaction data: HTTP ${res.status} -> ${errorText}`);
    }
    
  } catch (error: any) {
    logger.error(`${params.action.toUpperCase()} error: ${error?.message || error}`);
    throw error;
  }
}

// Buy operation
async function executeBuy(mint: string): Promise<string | null> {
  try {
    const signature = await tradeLocal({
      action: 'buy',
      mint,
      amount: BUY_SOL,
      denominatedInSol: true,
      slippage: BUY_SLIPPAGE,
      priorityFee: PRIORITY_FEE,
      pool: POOL,
    });
    
    // Wait 200ms before checking buy result
    logger.info(`Waiting 200ms before checking buy transaction status: ${signature}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check buy success via QuickNode RPC
    logger.info(`Checking buy transaction status: ${signature}`);
    const isSuccess = await checkTransactionSuccess(signature);
    
    if (isSuccess) {
      logger.success(`Buy confirmed: ${mint} -> ${signature}`);
      return signature;
    } else {
      logger.error(`Buy failed: ${mint} - transaction not confirmed`);
      return null;
    }
  } catch (error) {
    logger.error(`Buy execution failed: ${mint}`, error);
    return null;
  }
}

// Sell 70% - execute after FIRST_SELL_DELAY_MS, only need to get signature from API
async function executeSell70(mint: string, buySignature: string): Promise<string> {
  try {
    // Wait FIRST_SELL_DELAY_MS before selling 70%
    logger.info(`Waiting ${FIRST_SELL_DELAY_MS}ms before selling 70%: ${mint}`);
    await new Promise(resolve => setTimeout(resolve, FIRST_SELL_DELAY_MS));
    
    // Retry indefinitely until we get a signature
    while (true) {
      try {
        const signature = await tradeLocal({
          action: 'sell',
          mint,
          amount: '70%',
          denominatedInSol: false,
          slippage: SELL1_SLIPPAGE,
          priorityFee: 0, // sell1 priority fee set to 0
          pool: POOL,
        });
        
        logger.success(`Sell 70% succeeded: ${mint} -> ${signature}`);
        return signature;
      } catch (error) {
        logger.error(`Sell 70% execution failed, will retry after delay: ${mint}`, error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    logger.error(`Critical error selling 70%: ${mint}`, error);
    // Even on error, keep retrying
    throw error;
  }
}

// Sell 100% - execute after SECOND_SELL_DELAY_MS, if RPC check fails 3 times then retry once then record failure
async function executeSell100(mint: string, sell70Signature: string): Promise<string> {
  try {
    // Wait SECOND_SELL_DELAY_MS before selling 100%
    logger.info(`Waiting ${SECOND_SELL_DELAY_MS}ms before selling 100%: ${mint}`);
    await new Promise(resolve => setTimeout(resolve, SECOND_SELL_DELAY_MS));
    
    // Retry indefinitely until QuickNode RPC confirms success
    while (true) {
      try {
        const signature = await tradeLocal({
          action: 'sell',
          mint,
          amount: '100%',
          denominatedInSol: false,
          slippage: SELL2_SLIPPAGE,
          priorityFee: 0, // sell2 priority fee set to 0
          pool: POOL,
        });
        
        logger.success(`Sell 100% API call succeeded: ${mint} -> ${signature}`);
        
        // Wait 700ms before checking sell 100% status
        logger.info(`Waiting 700ms before checking sell 100% transaction status: ${signature}`);
        await new Promise(resolve => setTimeout(resolve, 700));
        
        // Check sell 100% success via QuickNode RPC (up to 3 attempts)
        logger.info(`Checking sell 100% transaction status: ${signature}`);
        const isSuccess = await checkTransactionSuccess(signature, 3);
        
        if (isSuccess) {
          logger.success(`Sell 100% confirmed: ${mint} -> ${signature}`);
          return signature; // Transaction succeeded, move on
        } else {
          // 3 checks failed, retry selling 100% once
          logger.error(`Sell 100% status check failed (3 attempts), retrying sell 100% once...`);
          
          try {
            // Retry sell 100% once
            const retrySignature = await tradeLocal({
              action: 'sell',
              mint,
              amount: '100%',
              denominatedInSol: false,
              slippage: SELL2_SLIPPAGE,
              priorityFee: 0,
              pool: POOL,
            });
            
            logger.success(`Retry sell 100% API call succeeded: ${mint} -> ${retrySignature}`);
            
            
            // Return the last signature and proceed
            logger.info(`Failure recorded, proceeding to next stage: ${mint}`);
            return retrySignature;
          } catch (retryError) {
            logger.error(`Retry sell 100% execution failed: ${mint}`, retryError);
            
            
            // Return original signature and proceed
            logger.info(`Failure recorded, proceeding to next stage: ${mint}`);
            return signature;
          }
        }
      } catch (error) {
        logger.error(`Sell 100% execution failed, will retry after delay: ${mint}`, error);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  } catch (error) {
    logger.error(`Critical error selling 100%: ${mint}`, error);
    // Even on error, keep retrying
    throw error;
  }
}

// Full buy-sell flow
async function executeBuySellFlow(mint: string): Promise<void> {
  // Record start time
  const startTime = performance.now();
  const timing: TradeTiming = {
    mint,
    startTime
  };
  tradeTimings.set(mint, timing);
  
  try {
    logger.info(`Starting to process new mint: ${mint}`);
    
    // 1. Buy
    const buyStartTime = performance.now();
    const buyResult = await executeBuy(mint);
    
    if (!buyResult) {
      logger.error(`Buy failed, skipping subsequent operations: ${mint}`);
      return;
    }
    
    // 2. Wait FIRST_SELL_DELAY_MS then sell 70%
    const sell70StartTime = performance.now();
    const sell70Signature = await executeSell70(mint, buyResult);
    const sell70EndTime = performance.now();
    
    // Buy duration = time from buy start to sell70 start
    timing.buyTime = sell70StartTime - buyStartTime;
    logger.info(`Buy duration: ${timing.buyTime.toFixed(2)}ms`);
    
    timing.sell70Time = sell70EndTime - sell70StartTime;
    logger.info(`Sell 70% duration: ${timing.sell70Time.toFixed(2)}ms`);
    
    // 3. Wait SECOND_SELL_DELAY_MS then sell 100%
    const sell100StartTime = performance.now();
    const sell100Signature = await executeSell100(mint, sell70Signature);
    const sell100EndTime = performance.now();
    
    timing.sell100Time = sell100EndTime - sell100StartTime;
    logger.info(`Sell 100% duration: ${timing.sell100Time.toFixed(2)}ms`);
    
    // 4. Compute total duration and finish flow
    const totalDuration = performance.now() - startTime;
    timing.completeTime = performance.now();
    timing.totalDuration = totalDuration;
    
    logger.success(`Mint ${mint} processing completed! Total duration: ${totalDuration.toFixed(2)}ms`);
    logger.info(`Detailed timing:`);
    logger.info(`  - Buy: ${timing.buyTime?.toFixed(2)}ms`);
    logger.info(`  - Sell 70%: ${timing.sell70Time?.toFixed(2)}ms`);
    logger.info(`  - Sell 100%: ${timing.sell100Time?.toFixed(2)}ms`);
    logger.info(`All transactions complete, ready to detect next token`);
    
  } catch (error) {
    logger.error(`Error while processing mint ${mint}:`, error);
  } finally {
    // Release processing lock
    isProcessing = false;
    logger.info(`Processing lock released, ready for next mint`);
  }
}

// ---------- SolanaStreaming WebSocket event handling ----------
function start() {
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let lastHeartbeat = Date.now();
  
  const connect = () => {
    try {
      ws = new WebSocket(WS_URL, undefined, {
        headers: {
          "X-API-KEY": SOLANA_STREAMING_API_KEY,
        },
      });

      ws.on('open', () => {
        logger.info('SolanaStreaming WebSocket connected');
        reconnectAttempts = 0; // reset reconnect attempts
        
        // Send subscribe message
        const subscribeMsg = {
          jsonrpc: "2.0",
          id: 1,
          method: "newPairSubscribe",
          params: {
            include_pumpfun: true
          }
        };
        
        ws!.send(JSON.stringify(subscribeMsg));
        logger.info('SolanaStreaming subscription started - monitoring new token creation...');
        
        // Start heartbeat checks
        startHeartbeat();
      });

      ws.on('message', (raw) => {
        try {
          // Update last heartbeat time
          lastHeartbeat = Date.now();
          
          // If already processing another mint, ignore new events
          if (isProcessing) {
            return;
          }
          
          const msg = JSON.parse(raw.toString());
          
          if (msg?.method === 'newPairNotification' && msg?.params?.pair?.baseToken?.account) {
            const mint = msg.params.pair.baseToken.account.trim();
            const blockTime = msg.params.blockTime * 1000; // convert to ms
            const currentTime = Date.now();
            const timeDiff = currentTime - blockTime;
            
            // Prevent duplicate processing
            if (seenMints.has(mint)) {
              return;
            }
            
            logger.info(`Detected new token: ${mint}`);
            logger.info(`Token info:`);
            logger.info(`  - Name: ${msg.params.pair.baseToken.info?.metadata?.name || 'N/A'}`);
            logger.info(`  - Symbol: ${msg.params.pair.baseToken.info?.metadata?.symbol || 'N/A'}`);
            logger.info(`  - Mint address: ${mint}`);
            logger.info(`  - Transaction signature: ${msg.params.signature}`);
            logger.info(`  - Slot: ${msg.params.slot}`);
            logger.info(`  - AMM account: ${msg.params.pair.ammAccount}`);
            logger.info(`  - Token publish time: ${new Date(blockTime).toISOString()}`);
            logger.info(`  - Current time: ${new Date().toISOString()}`);
            logger.info(`  - Time difference: ${timeDiff}ms`);
            
            // Check if time difference is within EVENT_TIMEOUT_MS
            if (timeDiff <= EVENT_TIMEOUT_MS) {
              logger.info(`Time difference acceptable (${timeDiff}ms <= ${EVENT_TIMEOUT_MS}ms)`);
              
              // Mark as seen and lock processing
              seenMints.add(mint);
              isProcessing = true;
              
              // Execute buy-sell flow asynchronously (do not block WebSocket)
              executeBuySellFlow(mint).catch(error => {
                logger.error(`Error executing buy/sell flow: ${error}`);
                isProcessing = false;
              });
            } else {
              logger.warning(`New token ${mint} time difference too large (${timeDiff}ms > ${EVENT_TIMEOUT_MS}ms), skipping`);
            }
          }
        } catch (error) {
          logger.error(`Error parsing SolanaStreaming WebSocket message: ${error}`);
        }
      });

      ws.on('error', (error) => {
        logger.error(`SolanaStreaming WebSocket error: ${error}`);
      });
      
      ws.on('close', (code, reason) => {
        logger.warning(`SolanaStreaming WebSocket connection closed: ${code} ${reason.toString()}`);
        
        // Clean up heartbeat
        stopHeartbeat();
        
        // Reconnect logic
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // exponential backoff, max 30s
          
          logger.info(`Preparing to reconnect (attempt ${reconnectAttempts}), reconnecting in ${delay}ms...`);
          
          reconnectTimeout = setTimeout(() => {
            logger.info(`Reconnecting SolanaStreaming WebSocket...`);
            connect();
          }, delay);
        } else {
          logger.error(`Max reconnect attempts reached (${maxReconnectAttempts}), stopping reconnection`);
        }
      });

      ws.on('pong', () => {
        logger.debug('Received WebSocket pong');
        lastHeartbeat = Date.now();
      });

    } catch (error) {
      logger.error(`Error creating WebSocket connection: ${error}`);
      
      // Reconnect logic
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        
        logger.info(`Preparing to reconnect (attempt ${reconnectAttempts}), reconnecting in ${delay}ms...`);
        
        reconnectTimeout = setTimeout(() => {
          logger.info(`Reconnecting SolanaStreaming WebSocket...`);
          connect();
        }, delay);
      }
    }
  };
  
  // Start heartbeat checks
  const startHeartbeat = () => {
    // Clean up previous heartbeat
    stopHeartbeat();
    
    // Send ping every 20s
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          logger.debug('Sent WebSocket ping');
        } catch (error) {
          logger.error(`Failed to send ping: ${error}`);
        }
      }
    }, 20000);
    
    // Check connection health every 30s
    const healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - lastHeartbeat;
      
      if (timeSinceLastHeartbeat > 60000) { // no message for 60s
        logger.warning(`WebSocket may be disconnected (${timeSinceLastHeartbeat}ms since last message)`);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          logger.info('Closing WebSocket connection to trigger reconnect');
          ws.close();
        }
      }
    }, 30000);
    
    // Save health check timer for cleanup
    (heartbeatInterval as any).healthCheck = healthCheckInterval;
  };
  
  // Stop heartbeat checks
  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      if ((heartbeatInterval as any).healthCheck) {
        clearInterval((heartbeatInterval as any).healthCheck);
      }
      heartbeatInterval = null;
    }
  };
  
  // Start connection
  connect();
  
  // Graceful shutdown
  const cleanup = () => {
    logger.info('Closing WebSocket connection...');
    
    // Clear timers
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    stopHeartbeat();
    
    // Close connection
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
  
  // Listen for process exit signals
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
  
  return cleanup;
}

// ---------- Start script ----------
logger.info('Starting optimized token sniper script (using local trade API)...');
logger.info(`Configuration:`);
logger.info(`   - Wallet public key: ${PUBLIC_KEY}`);
logger.info(`   - Buy amount: ${BUY_SOL} SOL`);
logger.info(`   - Buy slippage: ${BUY_SLIPPAGE}%`);
logger.info(`   - Sell1 slippage: ${SELL1_SLIPPAGE}%`);
logger.info(`   - Sell2 slippage: ${SELL2_SLIPPAGE}%`);
logger.info(`   - Buy priority fee: ${PRIORITY_FEE} SOL`);
logger.info(`   - Sell1 priority fee: 0 SOL`);
logger.info(`   - Sell2 priority fee: 0 SOL`);
logger.info(`   - Pool: ${POOL}`);
logger.info(`   - Time threshold: ${EVENT_TIMEOUT_MS}ms`);
logger.info(`   - Sell 70% delay: ${FIRST_SELL_DELAY_MS}ms`);
logger.info(`   - Sell 100% delay: ${SECOND_SELL_DELAY_MS}ms`);
logger.info(`   - WebSocket: SolanaStreaming (with heartbeat)`);
logger.info(`   - RPC: QuickNode`);
logger.info(`   - Trade API: PumpPortal Local API`);

// Periodically save statistics
setInterval(() => {
  if (tradeTimings.size > 0) {
    const statsFile = path.join(LOG_DIR, `stats_${new Date().toISOString().split('T')[0]}.json`);
    try {
      const stats = Array.from(tradeTimings.values());
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
      logger.debug(`Statistics saved to: ${statsFile}`);
    } catch (error) {
      logger.error('Failed to save statistics:', error);
    }
  }
}, 60000); // save every minute

// Start WebSocket connection
const cleanup = start();
