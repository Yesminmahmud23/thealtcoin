#!/bin/bash

# Text formatting for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables
VALIDATOR_PID=""
VALIDATOR_LOG="validator.log"

# Enhanced logging functions with timestamps
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

info() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $1${NC}"
}

# Function to check if a command exists
check_command() {
    if ! command -v $1 &> /dev/null; then
        error "$1 is not installed. Please install it first."
        exit 1
    fi
}

# Function to check wallet balance
check_balance() {
    local wallet=$1
    local network=$2
    local min_balance=$3

    if [ "$network" = "localnet" ]; then
        return 0  # Skip balance check for localnet
    fi

    balance=$(solana balance $wallet --url $network | awk '{print $1}')
    if (( $(echo "$balance < $min_balance" | bc -l) )); then
        error "Insufficient balance: $balance SOL. Minimum required: $min_balance SOL"
        exit 1
    fi
    log "Wallet balance: $balance SOL"
}

# Function to start local validator
start_local_validator() {
    log "Starting local validator..."

    # Kill any existing validator process
    pkill -f solana-test-validator
    rm -f $VALIDATOR_LOG

    # Start new validator
    solana-test-validator --reset > $VALIDATOR_LOG 2>&1 &
    VALIDATOR_PID=$!

    # Wait for validator to start
    local attempts=0
    local max_attempts=60
    while ! grep -q "Genesis Hash:" $VALIDATOR_LOG && [ $attempts -lt $max_attempts ]; do
        sleep 1
        attempts=$((attempts + 1))
        echo -n "."
    done
    echo

    if [ $attempts -eq $max_attempts ]; then
        error "Validator failed to start within ${max_attempts} seconds"
        stop_local_validator
        exit 1
    fi

    log "Local validator started successfully (PID: $VALIDATOR_PID)"
    sleep 5  # Give extra time for validator to stabilize
}

# Function to stop local validator
stop_local_validator() {
    if [ ! -z "$VALIDATOR_PID" ]; then
        log "Stopping local validator..."
        kill $VALIDATOR_PID 2>/dev/null || true
        pkill -f solana-test-validator 2>/dev/null || true
        rm -f $VALIDATOR_LOG
        VALIDATOR_PID=""
    fi
}

# Validate environment and tools
validate_environment() {
    log "Validating environment..."

    check_command solana
    check_command anchor
    check_command node

    if [ "$NETWORK" = "localnet" ]; then
        check_command solana-test-validator
    fi

    # Check if keypair exists
    if [ ! -f $DEPLOYER_KEYPAIR_PATH ]; then
        error "Deployer keypair not found at $DEPLOYER_KEYPAIR_PATH"
        exit 1
    fi
}

# Deploy the program
deploy_program() {
    local network=$1

    log "Building program..."
    anchor build || {
        error "Build failed"
        exit 1
    }

    # Get program ID from keypair
    PROGRAM_ID=$(solana-keygen pubkey target/deploy/thealtcoin-keypair.json)
    log "Program ID: $PROGRAM_ID"

    # Update Anchor.toml with program ID
    sed -i.bak "s/thealtcoin = \".*\"/thealtcoin = \"$PROGRAM_ID\"/" Anchor.toml

    # Update lib.rs with program ID
    sed -i.bak "s/declare_id!(\".*\")/declare_id!(\"$PROGRAM_ID\")/" programs/thealtcoin/src/lib.rs

    # Rebuild with updated program ID
    log "Rebuilding with updated program ID..."
    anchor build || {
        error "Rebuild failed"
        exit 1
    }

    # Deploy
    log "Deploying to $network..."
    if [ "$network" = "localnet" ]; then
        # For localnet, we use localhost URL
        anchor deploy \
            --provider.cluster http://localhost:8899 \
            --program-name thealtcoin \
            --program-keypair target/deploy/thealtcoin-keypair.json || {
            error "Deployment failed"
            return 1
        }
    else
        # For devnet/mainnet
        anchor deploy \
            --provider.cluster $network \
            --program-name thealtcoin \
            --program-keypair target/deploy/thealtcoin-keypair.json || {
            error "Deployment failed"
            return 1
        }
    fi
}

# Run tests
run_tests() {
    log "Running tests..."
    anchor test || {
        error "Tests failed"
        return 1
    }
}

# Main deployment process
main() {
    # Default values
    NETWORK=${1:-devnet}
    DEPLOYER_KEYPAIR_PATH=${2:-deploy-keypair.json}
    MIN_BALANCE_SOL=${3:-2}
    RUN_TESTS=${4:-false}

    if [[ "$NETWORK" != "devnet" && "$NETWORK" != "mainnet-beta" && "$NETWORK" != "localnet" ]];
    then
        error "Invalid network. Use 'localnet', 'devnet' or 'mainnet-beta'"
        exit 1
    fi

    # If mainnet, require higher minimum balance and confirmation
    if [ "$NETWORK" = "mainnet-beta" ]; then
        MIN_BALANCE_SOL=5
        warn "Deploying to mainnet! Please make sure this is intentional."
        read -p "Continue? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    log "Starting deployment process..."
    log "Network: $NETWORK"
    log "Deployer keypair: $DEPLOYER_KEYPAIR_PATH"
    log "Minimum balance required: $MIN_BALANCE_SOL SOL"

    # Start local validator if using localnet
    if [ "$NETWORK" = "localnet" ]; then
        start_local_validator
    fi

    # Run validations
    validate_environment
    check_balance $DEPLOYER_KEYPAIR_PATH $NETWORK $MIN_BALANCE_SOL

    # Run tests if enabled
    if [ "$RUN_TESTS" = "true" ] && [ "$NETWORK" = "localnet" ]; then
        run_tests || {
            stop_local_validator
            exit 1
        }
    fi

    # Deploy
    deploy_program $NETWORK || {
        [ "$NETWORK" = "localnet" ] && stop_local_validator
        exit 1
    }

    # Stop local validator if using localnet
    [ "$NETWORK" = "localnet" ] && stop_local_validator

    log "Deployment completed successfully! 🚀"
    log "Program ID: $PROGRAM_ID"
    log "Network: $NETWORK"
}

# Handle script interruption
cleanup() {
    error "Deployment interrupted"
    stop_local_validator
    exit 1
}

trap cleanup SIGINT SIGTERM

# Run main function with provided arguments
main "$@"