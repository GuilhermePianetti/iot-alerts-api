const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Inicializar Firebase Admin
// A credencial será carregada do ambiente no Render
let firebaseInitialized = false;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  
  firebaseInitialized = true;
  console.log('✅ Firebase inicializado com sucesso');
} catch (error) {
  console.error('❌ Erro ao inicializar Firebase:', error.message);
}

// Array para armazenar tokens dos dispositivos móveis (em produção, use um banco de dados)
let deviceTokens = [];

// Rota de teste
app.get('/', (req, res) => {
  res.json({ 
    status: 'API IoT Alerts rodando!',
    firebase: firebaseInitialized ? 'conectado' : 'não conectado',
    endpoints: {
      health: 'GET /',
      registerDevice: 'POST /register-device',
      sendAlert: 'POST /alert',
      listDevices: 'GET /devices'
    }
  });
});

// Registrar token do dispositivo móvel
app.post('/register-device', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token não fornecido' });
  }
  
  // Evitar duplicatas
  if (!deviceTokens.includes(token)) {
    deviceTokens.push(token);
    console.log(`📱 Novo dispositivo registrado. Total: ${deviceTokens.length}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Dispositivo registrado com sucesso',
    totalDevices: deviceTokens.length
  });
});

// Listar dispositivos registrados (para debug)
app.get('/devices', (req, res) => {
  res.json({ 
    totalDevices: deviceTokens.length,
    devices: deviceTokens.map((token, index) => ({
      id: index + 1,
      token: token.substring(0, 20) + '...' // Mostra apenas parte do token
    }))
  });
});

// Rota principal: receber alerta do ESP32 e enviar notificação
app.post('/alert', async (req, res) => {
  const { message, title, data } = req.body;
  
  console.log('🚨 Alerta recebido do ESP32:', { message, title, data });
  
  if (!firebaseInitialized) {
    return res.status(503).json({ 
      error: 'Firebase não inicializado',
      received: { message, title, data }
    });
  }
  
  if (deviceTokens.length === 0) {
    return res.status(200).json({ 
      warning: 'Nenhum dispositivo registrado para receber notificações',
      received: { message, title, data }
    });
  }
  
  // Preparar a mensagem de notificação
  const notification = {
    notification: {
      title: title || 'Alerta IoT',
      body: message || 'Novo alerta do seu dispositivo ESP32'
    },
    data: {
      timestamp: new Date().toISOString(),
      ...data // dados adicionais do ESP32
    }
  };
  
  try {
    // Enviar para todos os dispositivos registrados
    const promises = deviceTokens.map(token => 
      admin.messaging().send({
        ...notification,
        token: token
      }).catch(error => {
        // Se o token for inválido, remover da lista
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
          console.log(`🗑️  Removendo token inválido: ${token.substring(0, 20)}...`);
          deviceTokens = deviceTokens.filter(t => t !== token);
        }
        return { error: error.message, token };
      })
    );
    
    const results = await Promise.all(promises);
    const successful = results.filter(r => !r.error).length;
    const failed = results.filter(r => r.error).length;
    
    console.log(`✅ Notificações enviadas: ${successful} sucesso, ${failed} falhas`);
    
    res.json({ 
      success: true,
      message: 'Alerta processado',
      notificationsSent: successful,
      notificationsFailed: failed,
      totalDevices: deviceTokens.length,
      received: { message, title, data }
    });
    
  } catch (error) {
    console.error('❌ Erro ao enviar notificação:', error);
    res.status(500).json({ 
      error: 'Erro ao enviar notificação',
      details: error.message 
    });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Endpoints disponíveis em http://localhost:${PORT}`);
});