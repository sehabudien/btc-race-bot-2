# Caldera Dip Ladder

![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)
![rank](https://make.fun/badge/btc-race-24h-20261123-0511/sehabudien/btc-race-bot-2/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261123-0511/sehabudien/btc-race-bot-2/reward.svg)

A mean-reversion dip-buying bot for [make.fun's 24-hour BTC trading race](https://make.fun/bounty/btc-race-24h-20261123-0511). It buys price dips against a slow-trend filter, in up to three tranches as price falls further, and exits in stages: half at +0.8%, the rest at +1.7%, a trailing stop once in profit, a hard stop at -1.8%, and a 180-bar max hold.

Dev window (1,440 one-minute bars, official local grade): **net PnL +3.446803 USDC**, 8 trades across 3 round trips, deterministic (two runs byte-identical).
