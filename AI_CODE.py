# ai-service/app.py
# Community Capital AI/ML Service
# Handles OCR, receipt parsing, investment recommendations, and fraud detection

import os
import json
import logging
import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
import redis
import psycopg2
from psycopg2.extras import RealDictCursor
import cv2
import pytesseract
from PIL import Image
import re
from decimal import Decimal
import openai
import yfinance as yf
from sklearn.ensemble import RandomForestClassifier, IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
import joblib
import boto3
from transformers import pipeline
import google.cloud.vision as vision
from fuzzywuzzy import fuzz, process
import schedule
import threading
import time

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize services
redis_client = redis.from_url(os.getenv('REDIS_URL', 'redis://localhost:6379'))
openai.api_key = os.getenv('OPENAI_API_KEY')

# Initialize Google Vision client if available
try:
    vision_client = vision.ImageAnnotatorClient()
    GOOGLE_VISION_ENABLED = True
except:
    GOOGLE_VISION_ENABLED = False
    logger.warning("Google Vision API not configured")

# Initialize AWS S3 client
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    region_name=os.getenv('AWS_REGION', 'us-west-2')
)

# Database connection
def get_db_connection():
    return psycopg2.connect(
        os.getenv('DATABASE_URL'),
        cursor_factory=RealDictCursor
    )

# Load ML models
class MLModels:
    def __init__(self):
        self.fraud_detector = None
        self.spending_classifier = None
        self.investment_predictor = None
        self.load_or_train_models()
    
    def load_or_train_models(self):
        """Load pre-trained models or train new ones"""
        try:
            # Try loading existing models
            self.fraud_detector = joblib.load('models/fraud_detector.pkl')
            self.spending_classifier = joblib.load('models/spending_classifier.pkl')
            self.investment_predictor = joblib.load('models/investment_predictor.pkl')
        except:
            # Train new models if not found
            logger.info("Training new ML models...")
            self.train_fraud_detector()
            self.train_spending_classifier()
            self.train_investment_predictor()
    
    def train_fraud_detector(self):
        """Train fraud detection model using Isolation Forest"""
        # In production, use historical transaction data
        self.fraud_detector = IsolationForest(
            contamination=0.01,
            random_state=42
        )
        # Placeholder training - replace with actual data
        X_train = np.random.randn(1000, 10)
        self.fraud_detector.fit(X_train)
        joblib.dump(self.fraud_detector, 'models/fraud_detector.pkl')
    
    def train_spending_classifier(self):
        """Train spending pattern classifier"""
        self.spending_classifier = RandomForestClassifier(
            n_estimators=100,
            random_state=42
        )
        # Placeholder training
        X_train = np.random.randn(1000, 5)
        y_train = np.random.randint(0, 5, 1000)
        self.spending_classifier.fit(X_train, y_train)
        joblib.dump(self.spending_classifier, 'models/spending_classifier.pkl')
    
    def train_investment_predictor(self):
        """Train investment recommendation model"""
        # Simplified model - in production, use more sophisticated approaches
        self.investment_predictor = {
            'conservative': ['BND', 'AGG', 'TLT', 'VGSH'],
            'moderate': ['VTI', 'VOO', 'QQQ', 'VEA'],
            'aggressive': ['ARKK', 'ICLN', 'SOXX', 'XLK']
        }
        joblib.dump(self.investment_predictor, 'models/investment_predictor.pkl')

ml_models = MLModels()

# ========================
# Receipt OCR & Processing
# ========================

class ReceiptProcessor:
    def __init__(self):
        self.merchant_patterns = {
            'restaurant': ['restaurant', 'cafe', 'coffee', 'pizza', 'burger', 'sushi', 'grill'],
            'grocery': ['market', 'grocery', 'foods', 'walmart', 'target', 'costco'],
            'transport': ['uber', 'lyft', 'taxi', 'gas', 'shell', 'chevron'],
            'entertainment': ['cinema', 'theater', 'movie', 'concert', 'museum']
        }
        
        self.item_patterns = [
            r'(.+?)\s+\$?(\d+\.\d{2})',  # Item name followed by price
            r'(.+?)\s+(\d+\.\d{2})\s*$',  # Price at end of line
            r'(\d+)\s+(.+?)\s+@\s+\$?(\d+\.\d{2})',  # Quantity, item, unit price
        ]
    
    async def process_receipt(self, image_data: bytes) -> Dict:
        """Process receipt image and extract structured data"""
        try:
            # Try Google Vision first if available
            if GOOGLE_VISION_ENABLED:
                result = await self.process_with_google_vision(image_data)
                if result['success']:
                    return result
            
            # Fallback to Tesseract OCR
            result = await self.process_with_tesseract(image_data)
            
            # Enhance with GPT-4 if needed
            if result['confidence'] < 0.7:
                result = await self.enhance_with_gpt4(result, image_data)
            
            return result
            
        except Exception as e:
            logger.error(f"Receipt processing error: {e}")
            return {'success': False, 'error': str(e)}
    
    async def process_with_google_vision(self, image_data: bytes) -> Dict:
        """Use Google Cloud Vision API for OCR"""
        try:
            image = vision.Image(content=image_data)
            response = vision_client.document_text_detection(image=image)
            
            if response.error.message:
                raise Exception(response.error.message)
            
            text = response.full_text_annotation.text
            
            # Parse the extracted text
            parsed_data = self.parse_receipt_text(text)
            parsed_data['ocr_method'] = 'google_vision'
            parsed_data['confidence'] = 0.9
            parsed_data['success'] = True
            
            return parsed_data
            
        except Exception as e:
            logger.error(f"Google Vision error: {e}")
            return {'success': False, 'error': str(e)}
    
    async def process_with_tesseract(self, image_data: bytes) -> Dict:
        """Use Tesseract OCR for receipt processing"""
        try:
            # Convert bytes to image
            nparr = np.frombuffer(image_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            # Preprocess image
            processed_img = self.preprocess_image(img)
            
            # Extract text using Tesseract
            text = pytesseract.image_to_string(processed_img)
            data = pytesseract.image_to_data(processed_img, output_type=pytesseract.Output.DICT)
            
            # Calculate confidence
            confidences = [int(conf) for conf in data['conf'] if int(conf) > 0]
            avg_confidence = np.mean(confidences) / 100 if confidences else 0
            
            # Parse extracted text
            parsed_data = self.parse_receipt_text(text)
            parsed_data['ocr_method'] = 'tesseract'
            parsed_data['confidence'] = avg_confidence
            parsed_data['success'] = True
            
            return parsed_data
            
        except Exception as e:
            logger.error(f"Tesseract error: {e}")
            return {'success': False, 'error': str(e)}
    
    def preprocess_image(self, img):
        """Preprocess image for better OCR results"""
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply thresholding
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Denoise
        denoised = cv2.fastNlMeansDenoising(thresh)
        
        # Deskew
        coords = np.column_stack(np.where(denoised > 0))
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle = 90 + angle
        
        (h, w) = denoised.shape[:2]
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(denoised, M, (w, h), 
                                 flags=cv2.INTER_CUBIC, 
                                 borderMode=cv2.BORDER_REPLICATE)
        
        return rotated
    
    def parse_receipt_text(self, text: str) -> Dict:
        """Parse receipt text into structured data"""
        lines = text.strip().split('\n')
        
        result = {
            'merchant_name': None,
            'merchant_category': None,
            'items': [],
            'subtotal': 0,
            'tax': 0,
            'tip': 0,
            'total': 0,
            'date': None,
            'raw_text': text
        }
        
        # Extract merchant name (usually in first few lines)
        for line in lines[:5]:
            if len(line) > 3 and not any(char.isdigit() for char in line[:3]):
                result['merchant_name'] = line.strip()
                result['merchant_category'] = self.detect_merchant_category(line)
                break
        
        # Extract items and prices
        for line in lines:
            for pattern in self.item_patterns:
                match = re.search(pattern, line)
                if match:
                    groups = match.groups()
                    if len(groups) >= 2:
                        item_name = groups[0].strip() if len(groups) > 1 else groups[0].strip()
                        price = float(groups[-1])
                        
                        # Filter out totals and tax lines
                        if not any(keyword in item_name.lower() for keyword in 
                                 ['total', 'subtotal', 'tax', 'tip', 'gratuity', 'balance']):
                            result['items'].append({
                                'name': item_name,
                                'price': price,
                                'quantity': 1
                            })
        
        # Extract totals
        for line in lines:
            line_lower = line.lower()
            
            # Subtotal
            if 'subtotal' in line_lower:
                match = re.search(r'\$?(\d+\.\d{2})', line)
                if match:
                    result['subtotal'] = float(match.group(1))
            
            # Tax
            elif 'tax' in line_lower:
                match = re.search(r'\$?(\d+\.\d{2})', line)
                if match:
                    result['tax'] = float(match.group(1))
            
            # Tip
            elif 'tip' in line_lower or 'gratuity' in line_lower:
                match = re.search(r'\$?(\d+\.\d{2})', line)
                if match:
                    result['tip'] = float(match.group(1))
            
            # Total
            elif 'total' in line_lower and 'subtotal' not in line_lower:
                match = re.search(r'\$?(\d+\.\d{2})', line)
                if match:
                    result['total'] = float(match.group(1))
        
        # Extract date
        date_patterns = [
            r'(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
            r'(\d{4}[/-]\d{1,2}[/-]\d{1,2})',
            r'([A-Za-z]{3}\s+\d{1,2},?\s+\d{4})'
        ]
        
        for line in lines:
            for pattern in date_patterns:
                match = re.search(pattern, line)
                if match:
                    result['date'] = match.group(1)
                    break
        
        # Calculate missing values
        if not result['subtotal'] and result['items']:
            result['subtotal'] = sum(item['price'] for item in result['items'])
        
        if not result['total'] and result['subtotal']:
            result['total'] = result['subtotal'] + result['tax'] + result['tip']
        
        return result
    
    def detect_merchant_category(self, merchant_name: str) -> str:
        """Detect merchant category based on name"""
        merchant_lower = merchant_name.lower()
        
        for category, keywords in self.merchant_patterns.items():
            for keyword in keywords:
                if keyword in merchant_lower:
                    return category
        
        return 'other'
    
    async def enhance_with_gpt4(self, initial_result: Dict, image_data: bytes) -> Dict:
        """Use GPT-4 Vision to enhance OCR results"""
        try:
            # Convert image to base64
            import base64
            image_base64 = base64.b64encode(image_data).decode('utf-8')
            
            response = openai.ChatCompletion.create(
                model="gpt-4-vision-preview",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a receipt parsing expert. Extract merchant name, items with prices, subtotal, tax, tip, and total from the receipt image."
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": f"Parse this receipt. Initial OCR found: {json.dumps(initial_result)}. Please correct and complete the data."
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{image_base64}"
                                }
                            }
                        ]
                    }
                ],
                max_tokens=1000
            )
            
            # Parse GPT-4 response
            gpt_result = json.loads(response.choices[0].message.content)
            
            # Merge with initial result
            enhanced_result = {**initial_result, **gpt_result}
            enhanced_result['confidence'] = 0.95
            enhanced_result['ocr_method'] = 'gpt4_enhanced'
            
            return enhanced_result
            
        except Exception as e:
            logger.error(f"GPT-4 enhancement error: {e}")
            return initial_result

receipt_processor = ReceiptProcessor()

# ========================
# Investment Analysis
# ========================

class InvestmentAnalyzer:
    def __init__(self):
        self.sentiment_analyzer = pipeline("sentiment-analysis")
        self.risk_profiles = {
            'conservative': {
                'stocks': 0.3,
                'bonds': 0.5,
                'cash': 0.2,
                'risk_score': 2
            },
            'moderate': {
                'stocks': 0.6,
                'bonds': 0.3,
                'cash': 0.1,
                'risk_score': 5
            },
            'aggressive': {
                'stocks': 0.8,
                'bonds': 0.15,
                'cash': 0.05,
                'risk_score': 8
            }
        }
    
    async def get_recommendations(self, group_id: str, amount: float) -> Dict:
        """Get investment recommendations for a group"""
        try:
            # Get group profile
            group_profile = await self.get_group_profile(group_id)
            
            # Get market data
            market_data = await self.get_market_data()
            
            # Generate recommendations
            recommendations = self.generate_recommendations(
                group_profile,
                amount,
                market_data
            )
            
            # Add AI insights
            recommendations['ai_insights'] = await self.generate_ai_insights(
                group_profile,
                recommendations,
                market_data
            )
            
            return recommendations
            
        except Exception as e:
            logger.error(f"Investment analysis error: {e}")
            return {'error': str(e)}
    
    async def get_group_profile(self, group_id: str) -> Dict:
        """Get group investment profile from database"""
        conn = get_db_connection()
        cur = conn.cursor()
        
        try:
            # Get group details
            cur.execute("""
                SELECT g.*, 
                       COUNT(DISTINCT gm.user_id) as member_count,
                       AVG(u.lifetime_invested) as avg_member_investment
                FROM groups g
                JOIN group_members gm ON g.id = gm.group_id
                JOIN users u ON gm.user_id = u.id
                WHERE g.id = %s
                GROUP BY g.id
            """, (group_id,))
            
            group = cur.fetchone()
            
            # Get investment history
            cur.execute("""
                SELECT symbol, type, SUM(shares) as total_shares, 
                       AVG(average_cost) as avg_cost
                FROM investments
                WHERE group_id = %s
                GROUP BY symbol, type
            """, (group_id,))
            
            holdings = cur.fetchall()
            
            return {
                'group': dict(group) if group else {},
                'holdings': [dict(h) for h in holdings],
                'risk_profile': group['investment_strategy'] if group else 'moderate'
            }
            
        finally:
            cur.close()
            conn.close()
    
    async def get_market_data(self) -> Dict:
        """Fetch current market data"""
        try:
            # Popular ETFs and stocks
            symbols = ['SPY', 'QQQ', 'VTI', 'BND', 'GLD', 'AAPL', 'GOOGL', 'MSFT']
            
            market_data = {}
            for symbol in symbols:
                ticker = yf.Ticker(symbol)
                info = ticker.info
                hist = ticker.history(period="1mo")
                
                market_data[symbol] = {
                    'current_price': info.get('regularMarketPrice', 0),
                    'day_change': info.get('regularMarketChangePercent', 0),
                    'volume': info.get('regularMarketVolume', 0),
                    'pe_ratio': info.get('trailingPE', 0),
                    'market_cap': info.get('marketCap', 0),
                    'volatility': hist['Close'].pct_change().std() * np.sqrt(252)
                }
            
            # Add market sentiment
            market_data['sentiment'] = await self.get_market_sentiment()
            
            return market_data
            
        except Exception as e:
            logger.error(f"Market data fetch error: {e}")
            return {}
    
    async def get_market_sentiment(self) -> Dict:
        """Analyze market sentiment from news"""
        # In production, fetch from news APIs
        # For now, return mock data
        return {
            'overall': 'neutral',
            'score': 0.6,
            'fear_greed_index': 55
        }
    
    def generate_recommendations(self, profile: Dict, amount: float, 
                                market_data: Dict) -> Dict:
        """Generate investment recommendations based on profile and market"""
        
        risk_profile = self.risk_profiles[profile['risk_profile']]
        recommendations = []
        
        # Allocate based on risk profile
        stock_amount = amount * risk_profile['stocks']
        bond_amount = amount * risk_profile['bonds']
        cash_amount = amount * risk_profile['cash']
        
        # Stock recommendations
        if stock_amount > 0:
            if profile['risk_profile'] == 'conservative':
                recommendations.append({
                    'symbol': 'VTI',
                    'name': 'Vanguard Total Stock Market ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.7,
                    'reason': 'Broad market exposure with low fees'
                })
                recommendations.append({
                    'symbol': 'VIG',
                    'name': 'Vanguard Dividend Appreciation ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.3,
                    'reason': 'Stable dividend-paying companies'
                })
            elif profile['risk_profile'] == 'moderate':
                recommendations.append({
                    'symbol': 'VOO',
                    'name': 'Vanguard S&P 500 ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.5,
                    'reason': 'Core large-cap exposure'
                })
                recommendations.append({
                    'symbol': 'QQQ',
                    'name': 'Invesco QQQ Trust',
                    'type': 'etf',
                    'amount': stock_amount * 0.3,
                    'reason': 'Technology sector growth'
                })
                recommendations.append({
                    'symbol': 'VXUS',
                    'name': 'Vanguard International Stock ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.2,
                    'reason': 'International diversification'
                })
            else:  # aggressive
                recommendations.append({
                    'symbol': 'ARKK',
                    'name': 'ARK Innovation ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.3,
                    'reason': 'Disruptive innovation exposure'
                })
                recommendations.append({
                    'symbol': 'SOXX',
                    'name': 'iShares Semiconductor ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.3,
                    'reason': 'High-growth semiconductor sector'
                })
                recommendations.append({
                    'symbol': 'ICLN',
                    'name': 'iShares Global Clean Energy ETF',
                    'type': 'etf',
                    'amount': stock_amount * 0.4,
                    'reason': 'Clean energy megatrend'
                })
        
        # Bond recommendations
        if bond_amount > 0:
            recommendations.append({
                'symbol': 'BND',
                'name': 'Vanguard Total Bond Market ETF',
                'type': 'etf',
                'amount': bond_amount * 0.7,
                'reason': 'Diversified bond exposure'
            })
            recommendations.append({
                'symbol': 'TIP',
                'name': 'iShares TIPS Bond ETF',
                'type': 'etf',
                'amount': bond_amount * 0.3,
                'reason': 'Inflation protection'
            })
        
        # Calculate expected returns
        for rec in recommendations:
            if rec['symbol'] in market_data:
                rec['current_price'] = market_data[rec['symbol']]['current_price']
                rec['shares'] = rec['amount'] / rec['current_price']
                rec['expected_return'] = self.calculate_expected_return(
                    rec['symbol'],
                    market_data
                )
        
        return {
            'recommendations': recommendations,
            'total_amount': amount,
            'allocation': risk_profile,
            'expected_portfolio_return': self.calculate_portfolio_return(recommendations),
            'risk_score': risk_profile['risk_score']
        }
    
    def calculate_expected_return(self, symbol: str, market_data: Dict) -> float:
        """Calculate expected return for a symbol"""
        # Simplified calculation - in production use more sophisticated models
        if symbol in market_data:
            volatility = market_data[symbol].get('volatility', 0.15)
            sentiment_score = market_data.get('sentiment', {}).get('score', 0.5)
            
            # Base return + sentiment adjustment
            base_return = 0.08  # 8% historical average
            sentiment_adjustment = (sentiment_score - 0.5) * 0.1
            
            return base_return + sentiment_adjustment
        
        return 0.07  # Default 7% return
    
    def calculate_portfolio_return(self, recommendations: List[Dict]) -> float:
        """Calculate weighted portfolio return"""
        total_amount = sum(rec['amount'] for rec in recommendations)
        if total_amount == 0:
            return 0
        
        weighted_return = sum(
            rec['amount'] * rec.get('expected_return', 0.07) / total_amount
            for rec in recommendations
        )
        
        return weighted_return
    
    async def generate_ai_insights(self, profile: Dict, 
                                  recommendations: Dict,
                                  market_data: Dict) -> List[str]:
        """Generate AI-powered insights"""
        insights = []
        
        # Portfolio balance insight
        allocation = recommendations['allocation']
        if allocation['stocks'] > 0.7:
            insights.append(
                "Your portfolio is heavily weighted toward stocks. "
                "Consider rebalancing if market volatility increases."
            )
        elif allocation['bonds'] > 0.5:
            insights.append(
                "Conservative allocation detected. "
                "You may want to increase equity exposure for long-term growth."
            )
        
        # Market timing insight
        sentiment = market_data.get('sentiment', {})
        if sentiment.get('fear_greed_index', 50) < 30:
            insights.append(
                "Market fear is high - this could be a good buying opportunity "
                "for long-term investors."
            )
        elif sentiment.get('fear_greed_index', 50) > 70:
            insights.append(
                "Market greed is elevated - consider taking some profits "
                "or waiting for better entry points."
            )
        
        # Diversification insight
        if len(profile.get('holdings', [])) < 5:
            insights.append(
                "Your portfolio could benefit from more diversification. "
                "Consider adding different asset classes or sectors."
            )
        
        # Cost optimization
        total_amount = recommendations['total_amount']
        if total_amount < 1000:
            insights.append(
                "With smaller amounts, focus on low-cost index ETFs "
                "to minimize fees impact on returns."
            )
        
        return insights

investment_analyzer = InvestmentAnalyzer()

# ========================
# Fraud Detection
# ========================

class FraudDetector:
    def __init__(self):
        self.scaler = StandardScaler()
        
    async def check_transaction(self, transaction_data: Dict) -> Dict:
        """Check if a transaction might be fraudulent"""
        try:
            # Extract features
            features = self.extract_features(transaction_data)
            
            # Scale features
            features_scaled = self.scaler.fit_transform([features])
            
            # Predict using isolation forest
            prediction = ml_models.fraud_detector.predict(features_scaled)[0]
            score = ml_models.fraud_detector.score_samples(features_scaled)[0]
            
            # Additional rule-based checks
            rule_flags = self.apply_fraud_rules(transaction_data)
            
            is_suspicious = prediction == -1 or len(rule_flags) > 0
            
            result = {
                'is_suspicious': is_suspicious,
                'fraud_score': float(1 / (1 + np.exp(-score))),  # Convert to probability
                'flags': rule_flags,
                'recommendation': self.get_recommendation(is_suspicious, rule_flags)
            }
            
            # Log suspicious activity
            if is_suspicious:
                await self.log_suspicious_activity(transaction_data, result)
            
            return result
            
        except Exception as e:
            logger.error(f"Fraud detection error: {e}")
            return {'error': str(e)}
    
    def extract_features(self, transaction: Dict) -> List[float]:
        """Extract features for fraud detection"""
        features = [
            transaction.get('amount', 0),
            transaction.get('hour_of_day', 12),
            transaction.get('day_of_week', 3),
            transaction.get('days_since_last_transaction', 1),
            transaction.get('amount_deviation', 0),
            transaction.get('merchant_risk_score', 0.5),
            transaction.get('location_risk_score', 0.5),
            transaction.get('velocity_score', 0),  # Number of recent transactions
            transaction.get('user_trust_score', 100),
            transaction.get('is_international', 0)
        ]
        return features
    
    def apply_fraud_rules(self, transaction: Dict) -> List[str]:
        """Apply rule-based fraud detection"""
        flags = []
        
        # Amount-based rules
        if transaction.get('amount', 0) > 1000:
            flags.append('high_amount')
        
        if transaction.get('amount', 0) > transaction.get('user_avg_transaction', 100) * 5:
            flags.append('unusual_amount')
        
        # Velocity rules
        if transaction.get('transactions_last_hour', 0) > 5:
            flags.append('high_velocity')
        
        # Location rules
        if transaction.get('distance_from_last_location', 0) > 500:  # miles
            time_diff = transaction.get('hours_since_last_transaction', 24)
            if time_diff < 2:
                flags.append('impossible_travel')
        
        # Time-based rules
        hour = transaction.get('hour_of_day', 12)
        if hour < 6 or hour > 23:
            flags.append('unusual_time')
        
        # Merchant rules
        if transaction.get('merchant_first_time', False):
            if transaction.get('amount', 0) > 500:
                flags.append('high_amount_new_merchant')
        
        return flags
    
    def get_recommendation(self, is_suspicious: bool, flags: List[str]) -> str:
        """Get recommendation based on fraud analysis"""
        if not is_suspicious:
            return "Transaction appears normal"
        
        if 'impossible_travel' in flags:
            return "Block transaction - impossible travel detected"
        
        if len(flags) >= 3:
            return "Request additional verification"
        
        if 'high_amount' in flags:
            return "Request confirmation for high-value transaction"
        
        return "Monitor transaction"
    
    async def log_suspicious_activity(self, transaction: Dict, result: Dict):
        """Log suspicious activity to database"""
        conn = get_db_connection()
        cur = conn.cursor()
        
        try:
            cur.execute("""
                INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
                VALUES (%s, %s, %s, %s, %s)
            """, (
                transaction.get('user_id'),
                'suspicious_transaction',
                'transaction',
                transaction.get('id'),
                json.dumps(result)
            ))
            conn.commit()
        finally:
            cur.close()
            conn.close()

fraud_detector = FraudDetector()

# ========================
# API Endpoints
# ========================

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({'status': 'healthy', 'timestamp': datetime.utcnow().isoformat()})

@app.route('/api/ocr/receipt', methods=['POST'])
async def process_receipt():
    """Process receipt image and extract data"""
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400
        
        image = request.files['image']
        image_data = image.read()
        
        # Process receipt
        result = await receipt_processor.process_receipt(image_data)
        
        # Cache result
        cache_key = f"receipt:{hashlib.md5(image_data).hexdigest()}"
        redis_client.setex(cache_key, 3600, json.dumps(result))
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Receipt processing error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/investment/recommendations', methods=['POST'])
async def get_investment_recommendations():
    """Get AI-powered investment recommendations"""
    try:
        data = request.json
        group_id = data.get('group_id')
        amount = data.get('amount', 100)
        
        if not group_id:
            return jsonify({'error': 'Group ID required'}), 400
        
        recommendations = await investment_analyzer.get_recommendations(group_id, amount)
        
        return jsonify(recommendations)
        
    except Exception as e:
        logger.error(f"Investment recommendation error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/fraud/check', methods=['POST'])
async def check_fraud():
    """Check transaction for potential fraud"""
    try:
        transaction_data = request.json
        
        if not transaction_data:
            return jsonify({'error': 'Transaction data required'}), 400
        
        result = await fraud_detector.check_transaction(transaction_data)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Fraud detection error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/insights/spending', methods=['GET'])
def get_spending_insights():
    """Get AI-generated spending insights for user"""
    try:
        user_id = request.args.get('user_id')
        period = request.args.get('period', '30')  # days
        
        if not user_id:
            return jsonify({'error': 'User ID required'}), 400
        
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Get spending data
        cur.execute("""
            SELECT 
                DATE(created_at) as date,
                SUM(amount) as total,
                COUNT(*) as count,
                AVG(amount) as avg_amount
            FROM transactions
            WHERE user_id = %s 
                AND type = 'split_payment'
                AND created_at > NOW() - INTERVAL '%s days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        """, (user_id, int(period)))
        
        spending_data = cur.fetchall()
        
        # Generate insights
        insights = []
        
        if spending_data:
            total_spent = sum(day['total'] for day in spending_data)
            avg_daily = total_spent / len(spending_data)
            
            insights.append({
                'type': 'spending_pattern',
                'title': 'Spending Trend',
                'insight': f"You've spent ${total_spent:.2f} in the last {period} days, "
                          f"averaging ${avg_daily:.2f} per day.",
                'confidence_score': 0.95
            })
            
            # Find peak spending days
            peak_day = max(spending_data, key=lambda x: x['total'])
            insights.append({
                'type': 'peak_spending',
                'title': 'Highest Spending Day',
                'insight': f"Your highest spending was ${peak_day['total']:.2f} on {peak_day['date']}.",
                'confidence_score': 1.0
            })
        
        # Add AI-generated recommendations
        if total_spent > avg_daily * 30 * 1.2:  # 20% over average
            insights.append({
                'type': 'savings_opportunity',
                'title': 'Savings Opportunity',
                'insight': "Your spending is 20% higher than usual. "
                          "Consider reviewing recurring expenses for savings opportunities.",
                'potential_savings': total_spent * 0.15,
                'confidence_score': 0.8
            })
        
        cur.close()
        conn.close()
        
        return jsonify({
            'insights': insights,
            'period_days': period,
            'total_spent': total_spent if spending_data else 0
        })
        
    except Exception as e:
        logger.error(f"Spending insights error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/predict/split', methods=['POST'])
def predict_split():
    """Predict how to split a bill based on historical patterns"""
    try:
        data = request.json
        group_id = data.get('group_id')
        merchant = data.get('merchant')
        items = data.get('items', [])
        
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Get historical split patterns
        cur.execute("""
            SELECT 
                bp.user_id,
                u.name,
                AVG(bp.amount_owed) as avg_amount,
                COUNT(*) as frequency
            FROM bill_participants bp
            JOIN bills b ON bp.bill_id = b.id
            JOIN users u ON bp.user_id = u.id
            WHERE b.group_id = %s
                AND b.status = 'completed'
            GROUP BY bp.user_id, u.name
        """, (group_id,))
        
        patterns = cur.fetchall()
        
        # Generate predictions
        predictions = []
        total_amount = sum(item['price'] for item in items)
        
        for pattern in patterns:
            weight = pattern['frequency'] / sum(p['frequency'] for p in patterns)
            predicted_amount = total_amount * weight
            
            predictions.append({
                'user_id': pattern['user_id'],
                'name': pattern['name'],
                'predicted_amount': round(predicted_amount, 2),
                'confidence': min(pattern['frequency'] / 10, 1.0)  # Cap at 100%
            })
        
        cur.close()
        conn.close()
        
        return jsonify({
            'predictions': predictions,
            'total_amount': total_amount,
            'method': 'historical_pattern'
        })
        
    except Exception as e:
        logger.error(f"Split prediction error: {e}")
        return jsonify({'error': str(e)}), 500

# ========================
# Background Tasks
# ========================

def update_market_data():
    """Periodically update market data cache"""
    try:
        logger.info("Updating market data...")
        # Implementation here
    except Exception as e:
        logger.error(f"Market data update error: {e}")

def generate_daily_insights():
    """Generate daily insights for all users"""
    try:
        logger.info("Generating daily insights...")
        # Implementation here
    except Exception as e:
        logger.error(f"Daily insights generation error: {e}")

# Schedule background tasks
schedule.every(15).minutes.do(update_market_data)
schedule.every().day.at("06:00").do(generate_daily_insights)

def run_scheduler():
    """Run scheduled tasks in background thread"""
    while True:
        schedule.run_pending()
        time.sleep(60)

# Start scheduler thread
scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
scheduler_thread.start()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)