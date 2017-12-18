"use strict";
process.env.UV_THREADPOOL_SIZE = 128;
const appRoot  = require('app-root-path');
const events   = require('events');
const Logger   = require(appRoot + '/utils/logger.js');
const Poloniex = require('poloniex-api-node');
const Queue    = require('superqueue');

const config   = require(appRoot + '/config/local.config.json');

const Log = Logger('trader_01', appRoot + '/data/logs/ledger', appRoot + '/data/logs/info');
const emitter = new events.EventEmitter();
const poloniex = new Poloniex();
const privatePolo = {
    private_0: new Poloniex(...config.private_0),
    private_1: new Poloniex(...config.private_1),
    private_2: new Poloniex(...config.private_2),
    private_util: new Poloniex(...config.private_util),
};

const tradeCount = {
    total: 0,
    successful: 0,
    unsuccessful: 0,
};

const queue = new Queue({
    rate: 6,
    concurrency: 100000,
});
queue.addFlag('private_0', { concurrency: 1 });
queue.addFlag('private_1', { concurrency: 1 });
queue.addFlag('private_2', { concurrency: 1 });
queue.addFlag('private_util', { concurrency: 1 });
queue.addFlag('ticker', { concurrency: 100000, interval: 400 });

const prices = { BTC_ETH: {}, BTC_BCH: {}, ETH_BCH: {} };
const balances = { BTC: 0, ETH: 0, BCH: 0 };

let tradeInProgress = true;

process.on('unhandledRejection', (reason, p) => {
    Log.info('Unhandled Rejection at: Promise', p, 'reason:', reason);
});


// Permanent rolling ticker
const addTicker = (priority, once) => {
    if (tradeInProgress && !once) {
        return;
    }
    return queue.push({ flags: ['ticker'], priority: priority || 5 }, () => { return poloniex.returnTicker(); })
        .then((result) => {
            let changed = false;
            const newBTC_ETH = {
                highestBid: result.BTC_ETH.highestBid,
                lowestAsk: result.BTC_ETH.lowestAsk,
            };
            if (JSON.stringify(prices.BTC_ETH) !== JSON.stringify(newBTC_ETH)) {
                prices.BTC_ETH = newBTC_ETH;
                changed = true;
            }

            const newBTC_BCH = {
                highestBid: result.BTC_BCH.highestBid,
                lowestAsk: result.BTC_BCH.lowestAsk,
            };
            if (JSON.stringify(prices.BTC_BCH) !== JSON.stringify(newBTC_BCH)) {
                prices.BTC_BCH = newBTC_BCH;
                changed = true;
            }

            const newETH_BCH = {
                highestBid: result.ETH_BCH.highestBid,
                lowestAsk: result.ETH_BCH.lowestAsk,
            };
            if (JSON.stringify(prices.ETH_BCH) !== JSON.stringify(newETH_BCH)) {
                prices.ETH_BCH = newETH_BCH;
                changed = true;
            }
            if (changed) {
                //Log.info(Date.now() + ' ' + JSON.stringify(prices));
                emitter.emit('tryTrade');
            }
        })
        .catch((err) => {
            console.error('Error:', err);
        })
        .then(() => {
            if (!once) {
                setImmediate(addTicker);
            }
        });
};

const profitableCW = () => {
    const time = new Date();
    Log.info(`\n${time.toString()}`);
    Log.info('CW:', ((1 / prices.BTC_ETH.lowestAsk) / prices.ETH_BCH.lowestAsk) * prices.BTC_BCH.highestBid);
    return (((1 / prices.BTC_ETH.lowestAsk) / prices.ETH_BCH.lowestAsk) * prices.BTC_BCH.highestBid) > 1.008;
};

const profitableCCW = () => {
    Log.info('CCW:', (1 / prices.BTC_BCH.lowestAsk) * prices.ETH_BCH.highestBid * prices.BTC_ETH.highestBid);
    return ((1 / prices.BTC_BCH.lowestAsk) * prices.ETH_BCH.highestBid * prices.BTC_ETH.highestBid) > 1.008;
};

async function executeTrade({ pair, isForwards, poloName, price, amount }) {
    const polo = privatePolo[poloName];
    Log.ledger(`Pushing trade: ${isForwards ? 'buy' : 'sell'} ${pair}. Price: ${price}, Amount: ${amount}`);
    if (isForwards) {
        return await queue.push({ flags: [poloName], priority: 11 }, () => {
            Log.info(`Actually executing ${pair} buy`);
            return polo.buy(pair, price, amount, false, false, false);
        });
    } else {
        return await queue.push({ flags: [poloName], priority: 11 }, () => {
            Log.info(`Actually executing ${pair} sell`);
            return polo.sell(pair, price, amount, false, false, false);
        });
    }
}

async function tradesCompleted(orderIds) {
    await Log.info('\nAbout to check if trades are completed');
    // Get all outstanding orders, and flatten the array
    const currentOrders = (await queue.push({ flags: ['private_util'] }, () =>
        privatePolo.private_util.returnOpenOrders('all'))).values().reduce((acc, val) => acc.concat(val));
    await Log.info('Received current orders:', orderIds, currentOrders);
    const areCompleted = currentOrders.every((trade) => !orderIds.includes(trade.orderNumber));
    await Log.info('Checking if trades are completed: ', areCompleted);
    return areCompleted;
}

let i = 0;
async function finishTriangle() {
    const tradeNumber = ++tradeCount.total;
    await updateBalances();
    await addTicker(10);
    tradeInProgress = false;
    emitter.emit('tryTrade');
    const d = Date.now();
    await Log.ledger(`After trade #${tradeNumber}:`,
        `\n    Time:     ${d.toString()}`,
        '\n    Prices:   ', prices,
        '\n    Balances: ', balances,
        '\n    Record:   ', tradeCount);
    if (i++ === 4) {
        await Log.info('Shutting down');
        process.exit(1);
    }
}

async function updateBalances() {
    const newBal = await queue.push({ flags: ['private_util'] }, () => privatePolo.private_util.returnBalances());
    balances.BTC = newBal.BTC;
    balances.BCH = newBal.BCH;
    balances.ETH = newBal.ETH;
}

function wait(delay) {
    return new Promise((resolve, reject) => {
        setTimeout(() => resolve(), delay);
    });
}

function calculateTrade(triDetails) {
    triDetails.forEach((trade) => {
        trade.price = trade.isForwards ? prices[trade.pair].lowestAsk : prices[trade.pair].highestBid;
        trade.amount = 0.999 * (trade.isForwards ? balances[trade.pair.split('_')[0]] / prices[trade.pair].lowestAsk :
            balances[trade.pair.split('_')[1]]);
    });
}

async function cancelTrade(orderNumber) {
    const cancelSuccessful = await privatePolo.private_util.cancelOrder(orderNumber);
    Log.info(`Cancelled order ${orderNumber}. Details:`, cancelSuccessful);
    return cancelSuccessful.success === 1;
}

async function executeTriangle(isCW) {
    tradeInProgress = true;
    const d = Date.now();
    Log.ledger(`\nMaking ${isCW ? 'clockwise' : 'counter-clockwise'} trade (trade #${tradeCount.total + 1})`,
        `\n    Time:     ${d.toString()}`,
        '\n    Prices:   ', prices,
        '\n    Balances: ', balances);

    const triDetails = [
        { pair: 'BTC_ETH', isForwards: isCW, poloName: 'private_0' },
        { pair: 'BTC_BCH', isForwards: !isCW, poloName: 'private_1' },
        { pair: 'ETH_BCH', isForwards: isCW, poloName: 'private_2' },
    ];
    calculateTrade(triDetails);
    Log.info('Calculating triangle details', triDetails);

    let orders;
    try {
        orders = await Promise.all([
            executeTrade(triDetails[0]),
            executeTrade(triDetails[1]),
            executeTrade(triDetails[2]),
        ]);
    } catch (err) {
        await Log.info('Order placement failed', err);
        process.exit(1);
    }
    let orderNumbers = orders.map((order) => order.orderNumber);
    const startTime = Date.now();

    Log.info('\nTrades made with IDs:', orders, orderNumbers);

    // Check if trades are filled immediately
    const tradesFilled = orders.reduce((acc, order, i) => {
        if (!acc) {
            return acc;
        }
        const filledSum = order.resultingTrades.reduce((acc, trade) => acc + trade.amount, 0);
        console.log(`Checking ${triDetails[i].pair}`, triDetails[i].amount,
            filledSum, Math.abs(triDetails[i].amount - filledSum) < 0.00000001);
        return Math.abs(triDetails[i].amount - filledSum) < 0.00000001;
    }, true);

    if (tradesFilled) {
        Log.ledger(`Trade immediately successful after ${(Date.now() - startTime)/1000}s`);
        tradeCount.successful++;
        await finishTriangle();
        return;
    }

    while (Date.now() - startTime < 10000) {
        let tradesComplete = false;
        try {
            tradesComplete = await tradesCompleted(orderNumbers);
        } catch (e) {
            await Log.info('Error checking if trades completed', e);
        }
        if (tradesComplete) {
            Log.ledger(`Trade successful after ${(Date.now() - startTime)/1000}s`);
            tradeCount.successful++;
            await finishTriangle();
            return;
        }
    }

    let failureCount = 1;
    while (!await tradesCompleted(orderNumbers)) {
        Log.ledger(`Trade failed. Count: ${failureCount++}. Time: ${Date.now().toString()}`);
        // Cancel outstanding trades
        const cancelled = await Promise.all(orderNumbers.map((orderNumber) => cancelTrade(orderNumber)));
        if (cancelled.every((order) => !order)) {
            break;
        }

        // Try again at the new price
        await addTicker(10, true);
        orderNumbers = orderNumbers.map(async(orderNumber, i) => {
            if (!cancelled[i]) {
                return orderNumber;
            }
            calculateTrade([triDetails[i]]);
            Log.ledger(`Trying new makeup trade: `, triDetails[i]);
            orders[i] = await executeTrade(triDetails[i]);
            return orders[i].orderNumber;
        });

        await wait(10000);
    }
    // Uh-oh. Everything's gone wrong. Fix it here.

    Log.ledger(`Trade failed after ${(Date.now() - startTime)/1000}s`);
    tradeCount.unsuccessful++;
    await finishTriangle();
}

emitter.on('tryTrade', () => {
    if (tradeInProgress) {
        return;
    }
    //const time = new Date();
    //Log.info(time.toString(), 'Checking for triangular trade');
    try {
        if (profitableCW()) {
            Log.ledger('Detected clockwise trade');
            return executeTriangle(true);
        } else if (profitableCCW()) {
            Log.ledger('Detected counter-clockwise trade');
            return executeTriangle(false);
        }
    } catch (err) {
        Log.info('Attempting trade error', err);
    }
});

async function initialize() {
    await updateBalances();
    await addTicker(10, true);
    const time = new Date();
    await Log.ledger(`Initializing trader`,
        `\n    Time:     ${time.toString()}`,
        '\n    Prices:   ', prices,
        '\n    Balances: ', balances, '\n');
    tradeInProgress = false;
    addTicker();
}

initialize();
