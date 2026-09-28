package com.dashworldng.ai.ui.onboarding

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Business
import androidx.compose.material.icons.rounded.Compare
import androidx.compose.material.icons.rounded.Create
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Psychology
import androidx.compose.material.icons.rounded.Science
import androidx.compose.material.icons.rounded.TravelExplore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.R
import com.dashworldng.ai.ui.components.DashWordmark
import com.dashworldng.ai.ui.components.GoldButton
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Branded splash: the temporary Dash AI mark and wordmark fade in with the product line. */
@Composable
fun SplashScreen(onFinished: () -> Unit) {
    val reveal = remember { Animatable(0f) }
    val line = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        reveal.animateTo(1f, tween(700, easing = FastOutSlowInEasing))
        line.animateTo(1f, tween(450))
        delay(450)
        onFinished()
    }
    Box(Modifier.fillMaxSize().background(DashColors.Black).testTag("splash"), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                painter = painterResource(R.drawable.ic_splash_mark),
                contentDescription = null,
                tint = androidx.compose.ui.graphics.Color.Unspecified,
                modifier = Modifier
                    .size(112.dp)
                    .graphicsLayer {
                        alpha = reveal.value
                        scaleX = 0.92f + 0.08f * reveal.value
                        scaleY = 0.92f + 0.08f * reveal.value
                    },
            )
            DashWordmark(size = 30.dp, modifier = Modifier.alpha(reveal.value))
            Spacer(Modifier.height(14.dp))
            Text(
                "Think. Create. Execute.",
                style = MaterialTheme.typography.titleMedium,
                color = DashColors.Grey,
                modifier = Modifier.alpha(line.value),
            )
        }
    }
}

private data class OnboardingPage(val title: String, val body: String, val points: List<Pair<ImageVector, String>>)

private val pages = listOf(
    OnboardingPage(
        title = "Welcome to Dash AI",
        body = "Dash World's premium assistant for conversations, business planning, professional writing, documents and research.",
        points = listOf(
            Icons.Rounded.Forum to "Natural conversations that remember the context of your chat",
            Icons.Rounded.AutoAwesome to "Think. Create. Execute. — from idea to finished draft",
        ),
    ),
    OnboardingPage(
        title = "Choose how Dash AI thinks",
        body = "Every answer is labelled with the provider and model that wrote it.",
        points = listOf(
            Icons.Rounded.AutoAwesome to "Dash Smart picks the most suitable configured model",
            Icons.Rounded.Psychology to "OpenAI or Claude when you want a specific provider",
            Icons.Rounded.Compare to "Compare sends one prompt to both and shows the answers side by side — it uses both providers and may cost more",
        ),
    ),
    OnboardingPage(
        title = "Five focused modes",
        body = "Each mode changes the assistant's instructions and suggestions.",
        points = listOf(
            Icons.Rounded.Forum to "General · everyday questions",
            Icons.Rounded.Business to "Business · plans, strategy and pricing",
            Icons.Rounded.Create to "Writing · professional drafts and edits",
            Icons.Rounded.Description to "Documents · summaries and answers from your files",
            Icons.Rounded.TravelExplore to "Research · structured answers (live web search is not connected yet)",
        ),
    ),
    OnboardingPage(
        title = "Private by design",
        body = "Your prompts go only to the provider you choose, through Dash AI's secure server. Provider keys never live on your phone.",
        points = listOf(
            Icons.Rounded.Lock to "Conversations are saved on this device and excluded from backups",
            Icons.Rounded.Science to "Demo Mode works with no account and sends nothing anywhere",
        ),
    ),
)

@Composable
fun OnboardingScreen(onFinish: () -> Unit) {
    val pagerState = rememberPagerState { pages.size }
    val scope = rememberCoroutineScope()
    val last = pagerState.currentPage == pages.lastIndex
    Column(
        Modifier
            .fillMaxSize()
            .background(DashColors.Black)
            .systemBarsPadding()
            .testTag("onboarding"),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            DashWordmark(size = 18.dp)
            Spacer(Modifier.weight(1f))
            if (!last) TextButton(onClick = onFinish, modifier = Modifier.testTag("onboarding_skip")) { Text("Skip", color = DashColors.Grey) }
        }
        HorizontalPager(state = pagerState, modifier = Modifier.weight(1f)) { index ->
            val page = pages[index]
            Column(
                Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Spacer(Modifier.height(24.dp))
                Text(page.title, style = MaterialTheme.typography.headlineMedium, color = DashColors.White, modifier = Modifier.testTag("onboarding_title"))
                Text(page.body, style = MaterialTheme.typography.bodyLarge, color = DashColors.Grey)
                Spacer(Modifier.height(8.dp))
                page.points.forEach { (icon, text) ->
                    Surface(
                        shape = RoundedCornerShape(14.dp),
                        color = DashColors.Surface,
                        border = BorderStroke(1.dp, DashColors.OutlineSoft),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(icon, contentDescription = null, tint = DashColors.Gold)
                            Spacer(Modifier.width(12.dp))
                            Text(text, style = MaterialTheme.typography.bodyMedium, color = DashColors.White)
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(24.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(pages.size) { i ->
                    Box(
                        Modifier
                            .size(if (i == pagerState.currentPage) 22.dp else 8.dp, 8.dp)
                            .background(if (i == pagerState.currentPage) DashColors.Gold else DashColors.Outline, CircleShape),
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            GoldButton(
                text = if (last) "Get started" else "Next",
                onClick = {
                    if (last) onFinish() else scope.launch { pagerState.animateScrollToPage(pagerState.currentPage + 1) }
                },
                modifier = Modifier.testTag(if (last) "onboarding_start" else "onboarding_next"),
            )
        }
    }
}
