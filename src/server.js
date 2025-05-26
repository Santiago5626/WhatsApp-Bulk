const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('./utils/logger');
const multer = require('multer');
const XLSX = require('xlsx');
const app = express();

// [Previous configurations remain the same...]

// Variable para controlar la cancelación
let isCancelled = false;

// Variable para almacenar la conexión SSE actual
let progressClient = null;

// Función para enviar actualización de progreso
function sendProgressUpdate(data) {
    if (progressClient) {
        progressClient.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Ruta para eventos de progreso
app.get('/api/message-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    progressClient = res;

    req.on('close', () => {
        progressClient = null;
    });
});

// Ruta para cancelar el envío
app.post('/api/cancel-messages', (req, res) => {
    isCancelled = true;
    res.json({ success: true });
});

// Función para enviar mensajes en lotes
async function sendMessageBatch(numbers, message, config) {
    isCancelled = false;
    const results = {
        success: 0,
        error: 0
    };

    // Dividir números en lotes
    const batches = [];
    for (let i = 0; i < numbers.length; i += config.messagesBeforePause) {
        batches.push(numbers.slice(i, i + config.messagesBeforePause));
    }

    // Procesar cada lote
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        // Verificar si se ha cancelado el proceso
        if (isCancelled) {
            sendProgressUpdate({
                status: 'cancelled',
                currentNumber: batchIndex * config.messagesBeforePause + results.success,
                totalNumbers: numbers.length,
                currentBatch: batchIndex + 1,
                totalBatches: batches.length,
                successCount: results.success,
                errorCount: results.error
            });
            return results;
        }

        const batch = batches[batchIndex];
        logger.info(`Procesando lote ${batchIndex + 1} de ${batches.length}`);

        // Enviar mensajes del lote actual
        for (let messageIndex = 0; messageIndex < batch.length; messageIndex++) {
            // Verificar cancelación antes de cada mensaje
            if (isCancelled) {
                sendProgressUpdate({
                    status: 'cancelled',
                    currentNumber: batchIndex * config.messagesBeforePause + results.success,
                    totalNumbers: numbers.length,
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    successCount: results.success,
                    errorCount: results.error
                });
                return results;
            }

            const number = batch[messageIndex];
            const currentNumber = batchIndex * config.messagesBeforePause + messageIndex + 1;

            try {
                await client.sendMessage(number + '@c.us', message);
                logger.info(`Mensaje enviado a ${number}`);
                results.success++;

                sendProgressUpdate({
                    status: 'sending',
                    currentNumber,
                    totalNumbers: numbers.length,
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    successCount: results.success,
                    errorCount: results.error
                });

                await new Promise(resolve => setTimeout(resolve, config.delayBetweenMessagesMs));
            } catch (error) {
                console.error(`Error al enviar mensaje a ${number}:`, error);
                logger.error(`Error al enviar mensaje a ${number}: ${error.message}`);
                results.error++;
            }
        }

        // Si no es el último lote y no se ha cancelado, hacer una pausa
        if (batchIndex < batches.length - 1 && !isCancelled) {
            const pauseMs = config.pauseDurationMinutes * 60 * 1000;
            const pauseEndTime = Date.now() + pauseMs;

            sendProgressUpdate({
                status: 'paused',
                currentNumber: (batchIndex + 1) * config.messagesBeforePause,
                totalNumbers: numbers.length,
                currentBatch: batchIndex + 1,
                totalBatches: batches.length,
                successCount: results.success,
                errorCount: results.error,
                pauseEndTime
            });

            logger.info(`Pausa de ${config.pauseDurationMinutes} minuto(s) después del lote ${batchIndex + 1}...`);
            
            // Pausa con verificación de cancelación
            const startTime = Date.now();
            while (Date.now() - startTime < pauseMs && !isCancelled) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            if (!isCancelled) {
                logger.info('Pausa completada');
            }
        }
    }

    if (!isCancelled) {
        sendProgressUpdate({
            status: 'completed',
            currentNumber: numbers.length,
            totalNumbers: numbers.length,
            currentBatch: batches.length,
            totalBatches: batches.length,
            successCount: results.success,
            errorCount: results.error
        });
    }

    return results;
}

// [Previous routes remain the same...]

// Ruta para enviar mensajes
app.post('/api/send-messages', async (req, res) => {
    try {
        if (!isAuthenticated) {
            return res.status(401).json({ error: 'No autenticado en WhatsApp' });
        }

        const config = await loadConfig();
        
        if (!config.message || !config.numbers || config.numbers.length === 0) {
            return res.status(400).json({ error: 'No hay mensaje o números configurados' });
        }

        // Enviar respuesta inmediata
        res.json({ success: true });

        // Iniciar el proceso de envío
        logger.info('Iniciando envío de mensajes...');
        const results = await sendMessageBatch(config.numbers, config.message, config);
        logger.info('Envío de mensajes completado');

    } catch (error) {
        console.error('Error al enviar mensajes:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error al enviar mensajes' });
        }
    }
});

// [Rest of the code remains the same...]
