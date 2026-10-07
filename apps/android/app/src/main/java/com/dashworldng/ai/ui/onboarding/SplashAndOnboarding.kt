package com.dashworldng.ai.ui.onboarding

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Layers
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashworldng.ai.ui.components.BrandMark
import com.dashworldng.ai.ui.components.BrandWordmark
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.system.rememberReducedMotion
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The brand moment after the system splash: dark canvas, the mark, "DASH AI" and the line
 * "Beyond the Digital.". About 0.8 s in total (no long forced wait); instant with reduced motion.
 */
@Composable
fun SplashScreen(onFinished: () -> Unit) {
    SplashContent(reducedMotion = rememberReducedMotion(), onFinished = onFinished)
}

@Composable
fun SplashContent(reducedMotion: Boolean, onFinished: () -> Unit) {
    val c = DashTheme.colors
    val reveal = remember { Animatable(if (reducedMotion) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (reducedMotion) {
            delay(250)
        } else {
            launch { reveal.animateTo(1f, tween(durationMillis = 480, easing = FastOutSlowInEasing)) }
            delay(820)
        }
        onFinished()
    }
    Box(
        Modifier.fillMaxSize().background(c.brandCanvas).testTag("splash"),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.graphicsLayer {
                alpha = reveal.value
                translationY = (1f - reveal.value) * 12.dp.toPx()
            },
        ) {
            BrandMark(size = 56.dp)
            Spacer(Modifier.height(Spacing.lg))
            BrandWordmark(fontSize = 22.sp, onDark = true)
            Spacer(Modifier.height(Spacing.sm))
            Text(
                "Beyond the Digital.",
                style = MaterialTheme.typography.bodyLarge.copy(fontFamily = com.dashworldng.ai.ui.theme.BrandSerif),
                color = c.brandInk.copy(alpha = 0.72f),
            )
        }
        Text(
            "A Dash World product",
            style = MaterialTheme.typography.labelSmall,
            color = c.brandInk.copy(alpha = 0.55f),
            modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = Spacing.xxl),
        )
    }
}

private data class Cue(val icon: ImageVector, val title: String, val text: String)

private val cues = listOf(
    Cue(Icons.Rounded.Bolt, "Get answers faster", "Ask in your own words and get clear, structured answers."),
    Cue(Icons.Rounded.Layers, "Go deeper with context", "Add your documents and pick a focused mode for each chat."),
    Cue(Icons.Rounded.AutoAwesome, "Turn ideas into action", "Draft, plan and analyse in focused modes built for real work."),
)

/** One calm screen for first launch. Returning users never see it again. */
@Composable
fun OnboardingScreen(onFinish: () -> Unit) {
    val c = DashTheme.colors
    Box(Modifier.fillMaxSize().background(c.background).testTag("onboarding")) {
        ContentWidth(Modifier.fillMaxSize(), maxWidth = Sizing.maxFormWidth) {
            Column(
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.xl, vertical = Spacing.xl),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BrandMark(size = 26.dp)
                    Spacer(Modifier.width(Spacing.sm))
                    BrandWordmark(fontSize = 14.sp)
                }
                Spacer(Modifier.height(Spacing.xxxl))
                Text(
                    "What are we building today?",
                    style = MaterialTheme.typography.displaySmall,
                    color = c.ink,
                    modifier = Modifier.semantics { heading() }.testTag("onboarding_title"),
                )
                Spacer(Modifier.height(Spacing.md))
                Text(
                    "DASH AI helps you think, create, analyse and act.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = c.inkSecondary,
                )
                Spacer(Modifier.height(Spacing.xxl))
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.xl)) {
                    cues.forEach { cue -> CueRow(cue) }
                }
                Spacer(Modifier.weight(1f).height(Spacing.xxl))
                PrimaryButton(
                    "Get started",
                    onClick = onFinish,
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.xxl).testTag("onboarding_start"),
                )
                Spacer(Modifier.height(Spacing.md))
                Text(
                    "A Dash World product",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.inkTertiary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun CueRow(cue: Cue) {
    val c = DashTheme.colors
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.semantics(mergeDescendants = true) {}) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(c.accentContainer), contentAlignment = Alignment.Center) {
            Icon(cue.icon, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(Sizing.icon))
        }
        Spacer(Modifier.width(Spacing.lg))
        Column {
            Text(cue.title, style = MaterialTheme.typography.titleMedium, color = c.ink)
            Spacer(Modifier.height(Spacing.xxs))
            Text(cue.text, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        }
    }
}
