const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Inicializar Firebase Admin (opcional)
let firebaseInitialized = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    
    firebaseInitialized = true;
    console.log('✅ Firebase inicializado com sucesso');
  } else {
    console.log('⚠️  Firebase não configurado (variável FIREBASE_SERVICE_ACCOUNT não encontrada)');
  }
} catch (error) {
  console.error('❌ Erro ao inicializar Firebase:', error.message);
}

// Array para armazenar tokens dos dispositivos móveis
let deviceTokens = [];

// Função para detectar tipo de token
function detectTokenType(token) {
  if (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) {
    return 'expo';
  }
  // Tokens Firebase geralmente são strings longas aleatórias
  if (token.length > 100 && !token.includes('[')) {
    return 'firebase';
  }
  return 'unknown';
}

// Rota de teste
app.get('/', (req, res) => {
  res.json({ 
    status: 'API IoT Alerts rodando! (Modo Híbrido)',
    services: {
      expo: 'disponível',
      firebase: firebaseInitialized ? 'conectado' : 'não configurado'
    },
    totalDevices: deviceTokens.length,
    devicesByType: {
      expo: deviceTokens.filter(d => d.type === 'expo').length,
      firebase: deviceTokens.filter(d => d.type === 'firebase').length
    },
    endpoints: {
      health: 'GET /',
      registerDevice: 'POST /register-device',
      sendAlert: 'POST /alert',
      listDevices: 'GET /devices',
      clearDevices: 'POST /clear-devices'
    }
  });
});

// Registrar token do dispositivo móvel
app.post('/register-device', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token não fornecido' });
  }
  
  const tokenType = detectTokenType(token);
  
  if (tokenType === 'unknown') {
    return res.status(400).json({ 
      error: 'Tipo de token não reconhecido',
      received: token.substring(0, 50)
    });
  }
  
  // Verificar se já existe
  const existingToken = deviceTokens.find(d => d.token === token);
  
  if (!existingToken) {
    deviceTokens.push({
      token: token,
      type: tokenType,
      registeredAt: new Date().toISOString()
    });
    console.log(`📱 Novo dispositivo ${tokenType} registrado. Total: ${deviceTokens.length}`);
  } else {
    console.log(`♻️  Dispositivo ${tokenType} já registrado`);
  }
  
  res.json({ 
    success: true, 
    message: 'Dispositivo registrado com sucesso',
    tokenType: tokenType,
    totalDevices: deviceTokens.length,
    devicesByType: {
      expo: deviceTokens.filter(d => d.type === 'expo').length,
      firebase: deviceTokens.filter(d => d.type === 'firebase').length
    }
  });
});

// Listar dispositivos registrados
app.get('/devices', (req, res) => {
  res.json({ 
    totalDevices: deviceTokens.length,
    devices: deviceTokens.map((device, index) => ({
      id: index + 1,
      token: device.token.substring(0, 30) + '...',
      type: device.type,
      registeredAt: device.registeredAt
    })),
    summary: {
      expo: deviceTokens.filter(d => d.type === 'expo').length,
      firebase: deviceTokens.filter(d => d.type === 'firebase').length
    }
  });
});

// Função para enviar notificação via Expo Push API
async function sendExpoPushNotification(expoPushToken, title, message, data) {
  const notification = {
    to: expoPushToken,
    sound: 'default',
    title: title,
    body: message,
    data: data || {},
    priority: 'high',
    channelId: 'default',
  };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notification),
    });

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Erro ao enviar notificação Expo:', error);
    throw error;
  }
}

// Função para enviar notificação via Firebase
async function sendFirebasePushNotification(firebaseToken, title, message, data) {
  if (!firebaseInitialized) {
    throw new Error('Firebase não está inicializado');
  }

  const notification = {
    notification: {
      title: title,
      body: message
    },
    data: data || {},
    token: firebaseToken
  };

  try {
    const result = await admin.messaging().send(notification);
    return { success: true, messageId: result };
  } catch (error) {
    console.error('Erro ao enviar notificação Firebase:', error);
    throw error;
  }
}

// Rota principal: receber alerta do ESP32 e enviar notificação
app.post('/alert', async (req, res) => {
  const { message, title, data } = req.body;
  
  console.log('🚨 Alerta recebido:', { message, title, data });
  
  if (deviceTokens.length === 0) {
    return res.status(200).json({ 
      warning: 'Nenhum dispositivo registrado para receber notificações',
      received: { message, title, data }
    });
  }
  
  const notificationData = {
    timestamp: new Date().toISOString(),
    ...data
  };
  
  try {
    // Enviar para todos os dispositivos registrados
    const promises = deviceTokens.map(async (device) => {
      try {
        let result;
        
        if (device.type === 'expo') {
          // Enviar via Expo Push
          result = await sendExpoPushNotification(
            device.token,
            title || 'Alerta IoT',
            message || 'Novo alerta do seu dispositivo',
            notificationData
          );
          
          console.log(`✅ [EXPO] Notificação enviada para ${device.token.substring(0, 30)}...`);
          
          // Verificar se token é inválido
          if (result.data && result.data.status === 'error') {
            if (result.data.details?.error === 'DeviceNotRegistered') {
              console.log(`🗑️  [EXPO] Removendo token inválido`);
              deviceTokens = deviceTokens.filter(d => d.token !== device.token);
            }
            return { error: result.data.message, token: device.token, type: 'expo' };
          }
          
          return { success: true, token: device.token, type: 'expo' };
          
        } else if (device.type === 'firebase') {
          // Enviar via Firebase
          result = await sendFirebasePushNotification(
            device.token,
            title || 'Alerta IoT',
            message || 'Novo alerta do seu dispositivo',
            notificationData
          );
          
          console.log(`✅ [FIREBASE] Notificação enviada para ${device.token.substring(0, 30)}...`);
          
          return { success: true, token: device.token, type: 'firebase' };
        }
        
      } catch (error) {
        console.error(`❌ [${device.type.toUpperCase()}] Erro:`, error.message);
        
        // Remover tokens inválidos do Firebase
        if (device.type === 'firebase' && 
            (error.code === 'messaging/invalid-registration-token' ||
             error.code === 'messaging/registration-token-not-registered')) {
          console.log(`🗑️  [FIREBASE] Removendo token inválido`);
          deviceTokens = deviceTokens.filter(d => d.token !== device.token);
        }
        
        return { error: error.message, token: device.token, type: device.type };
      }
    });
    
    const results = await Promise.all(promises);
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => r.error).length;
    
    const successByType = {
      expo: results.filter(r => r.success && r.type === 'expo').length,
      firebase: results.filter(r => r.success && r.type === 'firebase').length
    };
    
    console.log(`📊 Resultado: ${successful} sucesso, ${failed} falhas`);
    console.log(`   └─ Expo: ${successByType.expo}, Firebase: ${successByType.firebase}`);
    
    res.json({ 
      success: true,
      message: 'Alerta processado',
      notificationsSent: successful,
      notificationsFailed: failed,
      byService: successByType,
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

// Rota para limpar dispositivos (útil para testes)
app.post('/clear-devices', (req, res) => {
  const previousCount = deviceTokens.length;
  const byType = {
    expo: deviceTokens.filter(d => d.type === 'expo').length,
    firebase: deviceTokens.filter(d => d.type === 'firebase').length
  };
  
  deviceTokens = [];
  console.log('🗑️  Todos os dispositivos foram removidos');
  
  res.json({ 
    success: true,
    message: 'Todos os dispositivos foram removidos',
    devicesRemoved: previousCount,
    removedByType: byType
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Modo Híbrido: Expo Push + Firebase Cloud Messaging`);
  console.log(`   ├─ Expo Push: ✅ Sempre disponível`);
  console.log(`   └─ Firebase: ${firebaseInitialized ? '✅ Conectado' : '⚠️  Não configurado'}`);
  console.log(`📱 Endpoints disponíveis em http://localhost:${PORT}`);
});