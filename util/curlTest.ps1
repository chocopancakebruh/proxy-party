$uri = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

$headers = @{
    "Authorization" = "Bearer YOUR_ACCESS_TOKEN"
    "Content-Type"  = "application/json"
}

$body = @{
    model    = "gemini-2.5-pro"
    project  = "YOUR_GOOGLE_CLOUD_PROJECT_ID"
    request  = @{
        contents = @(@{ role = "user"; parts = @(@{ text = "hi" }) })
    	tools = @()
    	generationConfig = @{
     	   thinkingConfig = @{ includeThoughts = $true }
    	}
    }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body