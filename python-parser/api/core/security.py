from typing import Optional, Dict, Any
import httpx
from fastapi import Depends, HTTPException, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from api.core.config import BACKEND_URL

security = HTTPBearer(auto_error=False)

async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    token_query: Optional[str] = Query(None, alias="token")
) -> Dict[str, Any]:
    """Verifies the JWT token by calling the Node.js Backend API."""
    token = None
    if credentials:
        token = credentials.credentials
    elif token_query:
        token = token_query
        
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated. Token missing.")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{BACKEND_URL}/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
                timeout=5.0
            )
            
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Token expired or invalid in backend")
            
        json_data = response.json()
        payload_data = json_data.get("data", {})
        
        if not json_data.get("success") or "user" not in payload_data:
            raise HTTPException(status_code=401, detail="Invalid token response from backend")
            
        user = payload_data["user"]
        return {
            "email": user.get("email"), 
            "role": user.get("role", "superadmin"),
            "id": str(user.get("id") or user.get("_id", ""))
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Token verification failed: {str(e)}")

def require_superadmin(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    return current_user