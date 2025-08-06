const { TronWeb } = require('tronweb');
const express = require('express');
const fetch = require('node-fetch');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const app = express();
app.use(express.json());
const tronWeb = new TronWeb({
  fullHost: 'https://api.shasta.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': '8664a39d-7dde-4ede-ab08-f5f3aeb6b652' }
});
const usdtContractAddress = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const payments = new Map();
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'USDT TRC-20 Payment API',
      version: '1.0.0',
    },
  },
  apis: ['./index.js'],
};
const specs = swaggerJsdoc(options);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
// Mock балансы для тестирования
const mockBalances = new Map();

// Функция для автоматического пополнения тестового адреса USDT
async function fundTestAddress(address, amount) {
  try {
    console.log(`Пополнение адреса ${address} на сумму ${amount} USDT...`);
    
    // Симулируем задержку транзакции
    setTimeout(() => {
      // Добавляем баланс в mock хранилище
      mockBalances.set(address, amount);
      console.log(`✅ Тестовое пополнение ${amount} USDT на адрес ${address} выполнено`);
      
      // Создаем mock транзакцию
      const mockTx = {
        transaction_id: `mock_tx_${Date.now()}`,
        value: (amount * 1e6).toString(), // USDT использует 6 десятичных знаков
        from: 'TTestFaucetAddress123456789',
        to: address,
        token_info: {
          address: usdtContractAddress,
          symbol: 'USDT',
          decimals: 6
        },
        block_timestamp: Date.now()
      };
      
      // Добавляем транзакцию в платеж
      if (payments.has(address)) {
        const payment = payments.get(address);
        payment.transactions.push(mockTx);
        console.log(`📝 Mock транзакция добавлена: ${mockTx.transaction_id}`);
      }
    }, 3000);
    
    return true;
  } catch (error) {
    console.error(`Ошибка пополнения адреса ${address}:`, error.message);
    return false;
  }
}

async function generatePaymentAddress(orderId, amount, ttlMinutes) {
  const account = await tronWeb.createAccount();
  const address = account.address.base58;
  const expiration = Date.now() + ttlMinutes * 60 * 1000;
  payments.set(address, { orderId, amount, expiration, status: 'pending', transactions: [] });
  
  // Автоматически пополняем тестовый адрес для демонстрации
  await fundTestAddress(address, amount);
  
  setTimeout(() => {
    if (payments.has(address) && payments.get(address).status === 'pending') {
      payments.delete(address);
    }
  }, ttlMinutes * 60 * 1000);
  return address;
}
async function getUsdtBalance(address) {
  // Сначала проверяем mock баланс для тестирования
  if (mockBalances.has(address)) {
    return mockBalances.get(address);
  }
  
  // Если mock баланса нет, проверяем реальный баланс
  try {
    const contract = await tronWeb.contract().at(usdtContractAddress);
    const balance = await contract.balanceOf(address).call({ from: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' });
    return Number(balance) / 1e6;
  } catch (error) {
    console.error(`Ошибка получения баланса для ${address}:`, error.message);
    return 0;
  }
}
async function getTransactions(address) {
  const payment = payments.get(address);
  // For mock payments, the transactions are already in the `payments` map
  if (payment && payment.transactions.length > 0) {
    return payment.transactions;
  }

  // For real addresses, fetch from TronGrid
  try {
    const url = `https://api.shasta.trongrid.io/v1/accounts/${address}/transactions/trc20`;
    const response = await fetch(url, { headers: { 'accept': 'application/json' } });
    const { data } = await response.json();
    return data || [];
  } catch (error) {
    console.error(`Failed to get transactions for ${address}:`, error.message);
    return [];
  }
}
async function getCurrentBlock() {
  return await tronWeb.trx.getCurrentBlock();
}
async function getTransactionInfo(txId) {
  return await tronWeb.trx.getTransactionInfo(txId);
}
async function sendNotification(orderId, message) {
  console.log(`Notification for order ${orderId}: ${message}`);
  // TODO: Implement real notification, e.g., fetch to webhook
  // await fetch('https://your-api.com/notify', { method: 'POST', body: JSON.stringify({ orderId, message }) });
}
async function monitorPayments() {
  setInterval(async () => {
    for (let [address, info] of payments) {
      try {
        // Skip if already confirmed
        if (info.status === 'confirmed') {
          continue;
        }

        if (Date.now() > info.expiration) {
          payments.delete(address);
          continue;
        }

        const balance = await getUsdtBalance(address);
        console.log(`Current balance for address ${address} (order ${info.orderId}): ${balance} USDT`);

        if (balance >= info.amount) {
          const txs = await getTransactions(address);
          console.log(`Found ${txs.length} transactions for address ${address}`);

          // Find a transaction that satisfies the payment amount
          const paymentTx = txs.find(tx => 
            tx.token_info.address === usdtContractAddress && 
            (Number(tx.value) / 1e6) >= info.amount
          );

          if (paymentTx) {
            console.log(`Processing transaction ${paymentTx.transaction_id} for ${info.amount} USDT.`);
            
            // For mock transactions, confirm immediately
            if (paymentTx.transaction_id.startsWith('mock_tx_')) {
              info.status = 'confirmed';
              info.transactions = [paymentTx]; // Store the confirming transaction
              await sendNotification(info.orderId, 'Payment confirmed');
              console.log(`✅ Mock платеж подтвержден для заказа ${info.orderId}`);
            } else {
              // For real transactions, check for confirmations
              const txInfo = await getTransactionInfo(paymentTx.transaction_id);
              if (txInfo && txInfo.blockNumber) {
                const currentBlock = await getCurrentBlock();
                const confirmations = currentBlock.block_header.raw_data.number - txInfo.blockNumber + 1;
                if (confirmations >= 3) { // Check for 3 confirmations
                  info.status = 'confirmed';
                  info.transactions = [paymentTx]; // Store the confirming transaction
                  await sendNotification(info.orderId, 'Payment confirmed');
                  console.log(`✅ Payment confirmed for order ${info.orderId} with tx ${paymentTx.transaction_id}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error monitoring address ${address}: ${error.message}`);
      }
    }
  }, 30000); // Check every 30 seconds
}
monitorPayments();
/**
 * @swagger
 * /generate-payment:
 *   post:
 *     summary: Generate a payment address for an order
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId, amount]
 *             properties:
 *               orderId:
 *                 type: string
 *                 description: Unique order identifier
 *               amount:
 *                 type: number
 *                 description: Payment amount in USDT
 *               ttl:
 *                 type: number
 *                 description: Time to live in minutes (default 30)
 *           example:
 *             orderId: "order123"
 *             amount: 10.5
 *             ttl: 60
 *     responses:
 *       200:
 *         description: Successfully generated address
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address:
 *                   type: string
 *             example:
 *               address: "T..."
 *       400:
 *         description: Invalid request parameters
 */
app.post('/generate-payment', async (req, res) => {
  const { orderId, amount, ttl = 30 } = req.body;
  const address = await generatePaymentAddress(orderId, amount, ttl);
  res.json({ address });
});
/**
 * @swagger
 * /payment-status/{address}:
 *   get:
 *     summary: Get payment status for an address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: The payment address
 *     responses:
 *       200:
 *         description: Payment status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, confirmed]
 *             example:
 *               status: "pending"
 *       404:
 *         description: Payment not found or expired
 */
app.get('/payment-status/:address', (req, res) => {
  const info = payments.get(req.params.address);
  if (info) {
    res.json({ status: info.status });
  } else {
    res.status(404).json({ error: 'Payment not found or expired' });
  }
});

/**
 * @swagger
 * /transactions/{address}:
 *   get:
 *     summary: Get all transactions for a specific address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: The TRON address
 *     responses:
 *       200:
 *         description: A list of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *             example:
 *               - transaction_id: "..."
 *                 value: "10000000"
 *                 from: "..."
 *                 to: "..."
 *       500:
 *         description: Error fetching transactions
 */
app.get('/transactions/:address', async (req, res) => {
  try {
    const transactions = await getTransactions(req.params.address);
    // Format transactions for display
    const formattedTransactions = transactions.map(tx => ({
      ...tx,
      value: (Number(tx.value) / 1e6).toFixed(2)
    }));
    res.json(formattedTransactions);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching transactions' });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});