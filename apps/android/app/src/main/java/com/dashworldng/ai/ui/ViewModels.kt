package com.dashworldng.ai.ui

import androidx.compose.runtime.Composable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory

/** Creates a ViewModel scoped to the current navigation destination, without a DI framework. */
@Composable
inline fun <reified VM : ViewModel> dashViewModel(crossinline create: () -> VM): VM =
    viewModel(factory = viewModelFactory { initializer { create() } })
