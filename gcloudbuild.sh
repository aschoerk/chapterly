gcloud auth application-default login
gcloud config set project chapterly-508015
gcloud run deploy chapterly \
                --source . \
                --region europe-west4 \
                --allow-unauthenticated \
                --memory 512Mi \
                --max-instances 1 \
                --update-env-vars NODE_ENV=production
