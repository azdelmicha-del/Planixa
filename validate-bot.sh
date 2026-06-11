#!/bin/bash
# Script para validar que Finanzas Bot está respondiendo con OpenAI en Render

APP_URL="https://finanzas-pro-app-q8i4.onrender.com"

echo "🔍 Validando Finanzas Bot en Render..."
echo ""

# Test 1: Health check
echo "1️⃣  Health Check (/healthz):"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$APP_URL/healthz")
if [ "$HEALTH" = "200" ]; then
    echo "   ✅ Servidor respondiendo (HTTP 200)"
else
    echo "   ❌ Servidor no responde (HTTP $HEALTH)"
    exit 1
fi
echo ""

# Test 2: Login
echo "2️⃣  Login:"
LOGIN_RESPONSE=$(curl -s -X POST "$APP_URL/api/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "azdelmicha@gmail.com",
    "password": "SuperAdmin2026!"
  }')

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo "   ❌ Login falló"
    echo "   Respuesta: $LOGIN_RESPONSE"
    exit 1
else
    echo "   ✅ Login exitoso"
    echo "   Token: ${TOKEN:0:20}..."
fi
echo ""

# Test 3: Chat con contexto mínimo
echo "3️⃣  Chat con OpenAI:"
CHAT_RESPONSE=$(curl -s -X POST "$APP_URL/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "message": "hola, ¿cómo estoy?",
    "context": {"salarios": 5000, "gastosFijos": 2000},
    "userRole": "admin"
  }')

RESPONSE_TEXT=$(echo "$CHAT_RESPONSE" | grep -o '"response":"[^"]*"' | cut -d'"' -f4 | head -c 100)

if [ -z "$RESPONSE_TEXT" ]; then
    echo "   ❌ Bot no respondió o error"
    echo "   Respuesta: $CHAT_RESPONSE"
    exit 1
else
    if [[ "$RESPONSE_TEXT" == *"Effi"* ]] || [[ "$RESPONSE_TEXT" == *"Transporte"* ]]; then
        echo "   ⚠️  Bot respondió en MODO OFFLINE (menú)"
        echo "   Respuesta: $RESPONSE_TEXT..."
        exit 1
    else
        echo "   ✅ Bot respondió con OpenAI"
        echo "   Respuesta: $RESPONSE_TEXT..."
    fi
fi
echo ""

echo "🎉 ¡Finanzas Bot está operativo con OpenAI!"
