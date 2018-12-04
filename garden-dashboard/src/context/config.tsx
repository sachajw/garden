/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import React from "react"

import { fetchConfig, FetchConfigResponse } from "../api"
import FetchContainer from "../containers/fetch-container"

type Context = { config: FetchConfigResponse }
const ConfigContext = React.createContext<Context | null>(null)

const ConfigConsumer = ConfigContext.Consumer

const Error = () => <p>Error loading sidebar</p>

const ConfigProvider = ({ children }) => (
  <FetchContainer<FetchConfigResponse> ErrorComponent={Error} skipSpinner fetchFn={fetchConfig}>
    {({ data: config }) => (
      <ConfigContext.Provider value={{ config }}>
        {children}
      </ConfigContext.Provider>
    )}
  </FetchContainer>
)

export { ConfigProvider, ConfigConsumer }
