import React, { createContext, useContext, useState } from 'react';

// NetworkContext provides the bridge URL and network/region selection.
const NetworkContext = createContext();

export const NetworkProvider = ({ children }) => {
  // Production network. The kernel pin (package.json) must match the kernel
  // deployed on this bridge; testnet (wss://testnet.axona.net) tracks the
  // newest kernel line for development.
  const [bridgeUrl, setBridgeUrl] = useState('wss://bridge.axona.net');
  const [network, setNetwork] = useState('production'); // or 'testnet'
  const [region, setRegion] = useState('eagle');

  const value = { 
    bridgeUrl, 
    setBridgeUrl, 
    network, 
    setNetwork, 
    region, 
    setRegion 
  };

  return (
    <NetworkContext.Provider value={value}>
      {children}
    </NetworkContext.Provider>
  );
};

export const useNetwork = () => useContext(NetworkContext);
