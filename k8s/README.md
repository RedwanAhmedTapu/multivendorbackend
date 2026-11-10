# Kubernetes deployment (free, self-hosted)

Managed Kubernetes (EKS/GKE/AKS) usually bills for the control plane. To
stay fully free, run one of these on your own VPS instead:

- **k3s** — https://k3s.io — `curl -sfL https://get.k3s.io | sh -`
  (single binary, ships Traefik ingress + metrics-server already)
- **MicroK8s** — https://microk8s.io — `sudo snap install microk8s --classic`
  (need to `microk8s enable ingress dns metrics-server` yourself)

Either gives you a real, production-capable Kubernetes cluster for the
cost of the VPS alone.

## Apply order

```bash
# 1. Build & push your image somewhere the cluster can pull it from
docker build -t <your-registry>/multivendorbackend:latest ..
docker push <your-registry>/multivendorbackend:latest

# 2. Create the secret from your real .env (never commit the filled-in file)
kubectl create secret generic multivendor-env --from-env-file=../.env

# 3. Apply everything
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml
kubectl apply -f ingress.yaml   # skip if using k3s's built-in Traefik instead

# 4. Watch it come up
kubectl get pods -w
```

## What each file does

| File              | Purpose                                                          |
|-------------------|-------------------------------------------------------------------|
| `deployment.yaml` | Runs 3 pods of the API image                                    |
| `service.yaml`    | Load-balances traffic across all healthy pods (free, built-in)  |
| `hpa.yaml`        | Auto-scales 3→10 pods under CPU load (free, built-in)            |
| `ingress.yaml`    | Exposes the Service to the internet via ingress-nginx (free)     |

## Before relying on this in production

Read the Socket.IO note in `../docker-compose.yml` and `service.yaml` —
real-time chat needs the `@socket.io/redis-adapter` wired into
`src/server.ts` once you run more than one replica, or messages won't
reach clients connected to a different pod.
