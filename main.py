
from pathlib import Path
from contextlib import asynccontextmanager

import joblib
import pandas as pd

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sklearn.pipeline import Pipeline
from xgboost import XGBClassifier


# ==================================================
# 1. CONFIGURATION
# ==================================================

BASE_DIR = Path(__file__).resolve().parent

PREPROCESSOR_PATH = BASE_DIR / "credit_risk_preprocessor.pkl"
XGB_MODEL_PATH = BASE_DIR / "credit_risk_xgb.json"
THRESHOLD_PATH = BASE_DIR / "best_threshold.pkl"

ml_model = {}


# ==================================================
# 2. LOAD MODEL AND THRESHOLD
# ==================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Loading Credit Risk model...")

    required_files = [
        PREPROCESSOR_PATH,
        XGB_MODEL_PATH,
        THRESHOLD_PATH,
    ]

    for path in required_files:
        if not path.is_file():
            raise FileNotFoundError(
                f"Required file not found: {path}"
            )

    # Load the saved preprocessing component
    preprocessor = joblib.load(PREPROCESSOR_PATH)

    # Load the XGBoost model using its native JSON format
    classifier = XGBClassifier()
    classifier.load_model(str(XGB_MODEL_PATH))

    # Reconstruct the prediction pipeline
    ml_model["model"] = Pipeline([
        ("preprocessor", preprocessor),
        ("classifier", classifier),
    ])

    # Load the selected classification threshold
    ml_model["threshold"] = float(
        joblib.load(THRESHOLD_PATH)
    )

    print("Credit Risk model loaded successfully!")
    print(f"Threshold: {ml_model['threshold']:.6f}")

    try:
        yield
    finally:
        ml_model.clear()
        print("Credit Risk model unloaded.")


# ==================================================
# 3. CREATE FASTAPI APPLICATION
# ==================================================

app = FastAPI(
    title="CreditLens - Credit Risk Prediction API",
    description=(
        "Predict loan default risk using a trained "
        "machine learning model."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


# ==================================================
# 4. CORS CONFIGURATION FOR LIVE SERVER
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ==================================================
# 5. HOME ENDPOINT
# ==================================================

@app.get("/")
def greet():
    return {
        "message": "CreditLens API is running",
        "status": "online",
        "documentation": "/docs",
    }


# ==================================================
# 6. HEALTH CHECK ENDPOINT
# ==================================================

@app.get("/health")
def health():
    model_loaded = "model" in ml_model
    threshold_loaded = "threshold" in ml_model

    return {
        "status": "ok" if model_loaded and threshold_loaded else "error",
        "model_loaded": model_loaded,
        "threshold_loaded": threshold_loaded,
    }


# ==================================================
# 7. INPUT DATA MODEL
# ==================================================

class LoanApplication(BaseModel):
    person_age: int = Field(..., ge=18, le=100)
    person_income: float = Field(..., gt=0)
    person_home_ownership: str
    person_emp_length: float = Field(..., ge=0)
    loan_intent: str
    loan_grade: str
    loan_amnt: float = Field(..., gt=0)
    loan_int_rate: float = Field(..., ge=0)
    loan_percent_income: float = Field(..., ge=0)
    cb_person_default_on_file: str
    cb_person_cred_hist_length: int = Field(..., ge=0)


# ==================================================
# 8. PREDICTION ENDPOINT
# ==================================================

@app.post("/predict")
def predict(data: LoanApplication):

    if "model" not in ml_model or "threshold" not in ml_model:
        raise HTTPException(
            status_code=503,
            detail="Credit Risk model is not loaded.",
        )

    # Convert input data into a DataFrame
    input_df = pd.DataFrame([data.model_dump()])

    model = ml_model["model"]
    threshold = float(ml_model["threshold"])

    # Predict probability of class 1
    probabilities = model.predict_proba(input_df)
    probability = float(probabilities[0, 1])

    # Apply the selected threshold
    prediction = int(probability >= threshold)

    return {
        "default_probability": probability,
        "default_prediction": prediction,
        "threshold": threshold,
        "Result": (
            "High Risk" if prediction == 1
            else "Low Risk"
        ),
    }
